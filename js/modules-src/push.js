  // =====================================================================
  // Web Push — real OS notifications (sound, lock screen, app closed)
  //
  // Everything the app called a "notification" before this was in-app
  // only: a Realtime subscription updating a badge or firing a toast while
  // the app happened to be open and focused. That misses exactly the cases
  // that matter — a job order dispatched while the technician's phone is
  // in their pocket, a fee proposed while the customer is doing something
  // else.
  //
  // Requires:
  //   - 20260916_03_push_subscriptions.sql (the subscriptions table)
  //   - the send-push Edge Function deployed, with VAPID secrets set
  //   - PUSH_PUBLIC_KEY below matching the deployed VAPID_PUBLIC_KEY
  //
  // Nothing here is load-bearing: if push isn't set up, isn't supported,
  // or the user declines, every function degrades to a silent no-op and
  // the app behaves exactly as it did before.
  // =====================================================================

  // Must match VAPID_PUBLIC_KEY in the Edge Function's secrets. The public
  // half is meant to ship to clients — it only lets a browser create a
  // subscription addressed to this server. The PRIVATE key never leaves
  // Supabase.
  const PUSH_PUBLIC_KEY = 'BDNnVSgi4tWomDM6KYn76Ng907epPyoPe2KZhBiopghXTPvSFW929BLSztbmTTwbLFahih7BIQVLdQz7vLmbEzc';

  function pushSupported(){
    return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
  }

  function urlBase64ToUint8Array(base64String){
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for(let i=0; i<raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // True when an existing subscription was made with PUSH_PUBLIC_KEY.
  // Browsers that don't expose options.applicationServerKey are assumed to
  // match (keeps the old behaviour rather than churning subscriptions).
  function pushKeyMatches(sub){
    try{
      const k = sub && sub.options && sub.options.applicationServerKey;
      if(!k) return true;
      const a = new Uint8Array(k), b = urlBase64ToUint8Array(PUSH_PUBLIC_KEY);
      if(a.length !== b.length) return false;
      for(let i=0; i<a.length; i++) if(a[i] !== b[i]) return false;
      return true;
    }catch(e){ return true; }
  }

  // Subscribes this device and stores the endpoint. Safe to call repeatedly
  // — the browser returns the SAME subscription for a device+origin, and
  // the row upserts on endpoint, so re-running never creates duplicates.
  async function pushSubscribe(){
    if(!pushSupported() || !currentUser) return false;
    if(Notification.permission !== 'granted') return false;
    if(!(await ensureCloud())) return false;
    try{
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // A subscription is bound to the VAPID public key it was created
      // with. After a key rotation, the browser still holds the OLD one,
      // and every push sent with the new key is rejected — so throw it
      // away and subscribe again under the current key.
      if(sub && !pushKeyMatches(sub)){
        const oldEndpoint = sub.endpoint;
        try{ await sub.unsubscribe(); }catch(e){}
        try{ await db.from('push_subscriptions').delete().eq('endpoint', oldEndpoint); }catch(e){}
        sub = null;
      }
      if(!sub){
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true, // required by Chrome; every push must show something
          applicationServerKey: urlBase64ToUint8Array(PUSH_PUBLIC_KEY)
        });
      }
      const json = sub.toJSON();
      if(!json || !json.keys) return false;
      const { error } = await db.from('push_subscriptions').upsert({
        user_id: currentUser.id,
        customer_id: currentUser.role==='customer' ? (currentUser.customerId || null) : null,
        role: currentUser.role==='admin' ? 'admin' : (currentUser.role==='customer' ? 'customer' : 'tech'),
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        user_agent: navigator.userAgent.slice(0, 300),
        last_seen_at: new Date().toISOString()
      }, { onConflict: 'endpoint' });
      if(error) throw error;
      return true;
    }catch(e){ console.error('push subscribe failed', describeCloudError(e)); return false; }
  }

  // Asks for permission, then subscribes. Called from the in-app prompt
  // rather than on load: a permission dialog that appears before someone
  // understands what it's for is usually dismissed, and a dismissal is
  // sticky — the browser won't ask again.
  async function pushRequestPermission(){
    if(!pushSupported()){ toast('This device does not support notifications'); return false; }
    if(Notification.permission === 'denied'){
      toast('Notifications are blocked — turn them back on in your browser settings for this site');
      return false;
    }
    let perm = Notification.permission;
    if(perm !== 'granted') perm = await Notification.requestPermission();
    if(perm !== 'granted'){ toast('Notifications stay off — you can turn them on later'); return false; }
    const ok = await pushSubscribe();
    toast(ok ? 'Notifications are on for this device' : 'Could not turn on notifications — try again');
    return ok;
  }

  // Signing out removes only THIS device's row: other devices the same
  // person uses keep working.
  async function pushUnsubscribeThisDevice(){
    if(!pushSupported()) return;
    try{
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if(!sub) return;
      const endpoint = sub.endpoint;
      try{ await sub.unsubscribe(); }catch(e){}
      if(await ensureCloud()){
        await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
      }
    }catch(e){ /* signing out must never fail because of this */ }
  }

  // Re-subscribes a returning user silently when permission is already
  // granted (endpoints rotate, and a row may have been pruned as dead).
  async function pushInit(){
    if(!pushSupported() || !currentUser) return;
    if(Notification.permission === 'granted') pushSubscribe();
    navigator.serviceWorker.addEventListener('message', (e)=>{
      if(e.data && e.data.type==='push-subscription-changed') pushSubscribe();
    });
  }

  // ---------------------------------------------------------------------
  // Sending
  //
  // Every call is best-effort and deliberately NOT awaited by its caller:
  // a notification failing must never stop the action that triggered it
  // from completing. The audience is resolved server-side (see the Edge
  // Function) — callers name an audience, never a recipient list.
  // ---------------------------------------------------------------------
  async function notifyPush({ audience, customerId, userId, title, message, url, tag }){
    if(!(await ensureCloud())) return;
    try{
      await db.functions.invoke('send-push', {
        body: { audience, customerId, userId, title, message, url, tag }
      });
    }catch(e){ console.warn('notifyPush failed (non-fatal)', e && e.message); }
  }
  function notifyAdmins(title, message, tag){
    notifyPush({ audience:'admins', title, message, tag }).catch(()=>{});
  }
  function notifyCustomer(customerId, title, message, tag){
    if(!customerId) return;
    notifyPush({ audience:'customer', customerId, title, message, tag }).catch(()=>{});
  }
  function notifyUser(userId, title, message, tag){
    if(!userId) return;
    notifyPush({ audience:'user', userId, title, message, tag }).catch(()=>{});
  }
  function notifyTechnicians(title, message, tag){
    notifyPush({ audience:'technicians', title, message, tag }).catch(()=>{});
  }

  // ---------------------------------------------------------------------
  // The three in-app toggles (admin cloud sheet, technician profile,
  // customer profile). One shared handler — the only difference between
  // them is which pair of element ids they render into.
  // ---------------------------------------------------------------------
  const PUSH_TOGGLES = [
    { status:'pushStatusAdmin', btn:'pushEnableAdminBtn' },
    { status:'pushStatusTech',  btn:'pushEnableTechBtn' },
    { status:'pushStatusCust',  btn:'pushEnableCustBtn' }
  ];
  function pushRefreshToggles(){
    let label, showBtn = true;
    if(!pushSupported()){ label = 'Not supported on this device'; showBtn = false; }
    else if(Notification.permission === 'granted'){ label = 'On'; showBtn = false; }
    else if(Notification.permission === 'denied'){ label = 'Blocked in browser settings'; showBtn = false; }
    else label = 'Off';
    PUSH_TOGGLES.forEach(t=>{
      const s = $(t.status), b = $(t.btn);
      if(s) s.textContent = label;
      if(b) b.style.display = showBtn ? '' : 'none';
    });
  }
  PUSH_TOGGLES.forEach(t=>{
    const b = $(t.btn);
    if(b) b.addEventListener('click', async ()=>{
      b.disabled = true;
      await pushRequestPermission();
      b.disabled = false;
      pushRefreshToggles();
    });
  });
  pushRefreshToggles();
