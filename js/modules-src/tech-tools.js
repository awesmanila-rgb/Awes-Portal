  // =====================================================================
  // Technician Tools — calculators, standards tables and troubleshooting,
  // for technicians on site (no signal needed; nothing here touches the
  // network). Same visual language as the customer portal's own Tools
  // screen (.ct-* classes, cpCalcShell etc. in customer-portal.js) — this
  // module supplies the technician-only content: a real duct sizing
  // calculator plus reference tables a tech would otherwise carry on
  // paper or look up on their phone mid-job.
  //
  // Screen: #techToolsView holds two panels toggled by ttShowGrid()/
  // ttShowDetail() — #ttToolsScreen (the grid) and #ttCalcScreen (one
  // calculator or table at a time). Opened from the "Calculators" tile
  // on Home (#techQaCalculators, wired in home.js-style fashion below).
  // =====================================================================

  function showTechToolsView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('techToolsView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Calculators', 'Duct sizing, standards & troubleshooting');
    ttShowGrid();
    ttRenderGrid();
    window.scrollTo({top:0});
  }
  function ttShowGrid(){
    $('ttCalcScreen').style.display = 'none';
    $('ttToolsScreen').style.display = '';
  }
  function ttShowDetail(){
    $('ttToolsScreen').style.display = 'none';
    $('ttCalcScreen').style.display = '';
    window.scrollTo({top:0});
  }
  const techQaCalcBtn = $('techQaCalculators');
  if(techQaCalcBtn) techQaCalcBtn.addEventListener('click', showTechToolsView);
  const ttBackBtn = $('ttCalcBackBtn');
  if(ttBackBtn) ttBackBtn.addEventListener('click', ttShowGrid);

  // ---- generic bisection helper (all the sizing math below is a monotonic
  // function of one unknown, so one small solver covers everything). ----
  function ttSolve(fn, lo, hi, target, iters){
    iters = iters || 60;
    let flo = fn(lo) - target, fhi = fn(hi) - target;
    if(!(isFinite(flo) && isFinite(fhi))) return NaN;
    // fn is assumed monotonic; if both ends are on the same side, clamp.
    if(flo*fhi > 0) return flo > 0 ? lo : hi;
    for(let i=0;i<iters;i++){
      const mid = (lo+hi)/2, fm = fn(mid)-target;
      if(Math.abs(fm) < 1e-7) return mid;
      if((fm>0) === (flo>0)){ lo = mid; flo = fm; } else { hi = mid; }
    }
    return (lo+hi)/2;
  }

  // =====================================================================
  // 1. Ductulator — round & rectangular duct sizing by velocity or by
  // equal-friction method, using real duct airflow physics (Darcy-Weisbach
  // with the Swamee-Jain explicit friction factor) instead of a rough
  // curve-fit, so it tracks a real friction chart closely.
  // =====================================================================
  const TTD_RHO = 0.075;       // lb/ft3, standard air
  const TTD_NU = 0.000163;     // ft2/s, kinematic viscosity of air ~21C
  const TTD_EPS = 0.0003;      // ft, absolute roughness, galvanized duct
  // Darcy friction factor for a round duct of diameter D (in) carrying cfm.
  function ttFrictionRate(cfm, dIn){
    const dFt = dIn/12;
    const aFt2 = Math.PI*dFt*dFt/4;
    const vFps = (cfm/60)/aFt2;
    const re = vFps*dFt/TTD_NU;
    if(re < 1) return 0;
    const relRough = TTD_EPS/dFt;
    const f = 0.25/Math.pow(Math.log10(relRough/3.7 + 5.74/Math.pow(re,0.9)), 2);
    const dpPsf = f*(100/dFt)*(TTD_RHO*vFps*vFps)/(2*32.174);
    return dpPsf/5.202; // in. w.g. per 100 ft
  }
  function ttVelocityFps(cfm, dIn){
    const dFt = dIn/12, aFt2 = Math.PI*dFt*dFt/4;
    return (cfm/60)/aFt2;
  }
  // Round duct diameter (inches) for a target face velocity (fpm).
  function ttDiaByVelocity(cfm, fpm){
    const aFt2 = cfm/fpm;
    return Math.sqrt(4*aFt2/Math.PI)*12;
  }
  // Round duct diameter (inches) for a target equal-friction rate (in.wg/100ft).
  function ttDiaByFriction(cfm, fr){
    return ttSolve((d)=> ttFrictionRate(cfm, d), 2, 80, fr);
  }
  // ASHRAE/Huebscher equivalent round diameter of a rectangular duct a x b (in).
  function ttEquivDia(a, b){
    return 1.30*Math.pow(a*b, 0.625)/Math.pow(a+b, 0.25);
  }
  // Given one known side `a` (in) and a target equivalent diameter De (in),
  // solve for the other side b.
  function ttRectOtherSide(a, de){
    return ttSolve((b)=> ttEquivDia(a,b), Math.max(1,a*0.15), a*20, de);
  }
  function ttCalcDuctulator(){
    cpCalcHostTech = true;
    cpCalcShell('ductulator', {
      title:'Ductulator',
      form:
        cpField('Airflow', cpInput('ttCfm', 500, 'CFM', 'min="0" step="10"'))+
        cpField('Sizing method', cpSeg('ttMethod', [['vel','Velocity'],['fric','Equal friction']], 'fric'))+
        '<div id="ttMethVel" style="display:none">'+
          cpField('Target velocity', cpInput('ttVel', 900, 'fpm'), 'Typical: 1200–1500 main trunk, 900–1200 branch, 500–700 return/grille face.')+
        '</div>'+
        '<div id="ttMethFric">'+
          cpField('Friction rate', cpInput('ttFric', 0.08, 'in.wg / 100 ft', 'min="0.01" step="0.01"'), 'Typical residential/light-commercial design: 0.08–0.10 in.wg per 100 ft.')+
        '</div>'+
        cpField('Duct shape', cpSeg('ttShape', [['round','Round'],['rect','Rectangular']], 'round'))+
        '<div id="ttRectRow" style="display:none">'+
          cpField('Known side (height)', cpInput('ttSideA', 8, 'in', 'min="2" step="0.5"'))+
        '</div>',
      how:
        '<p>Friction rate is calculated from real duct airflow physics — the Darcy-Weisbach equation with the Swamee-Jain friction factor — for galvanized round duct, not a rough rule of thumb. Standard air (0.075 lb/ft³) and typical galvanized roughness are assumed.</p>'+
        '<p><b>Equal friction method:</b> pick a friction rate (0.08–0.10 in.wg/100 ft is common for residential/light commercial) and every duct section is sized to that same rate — the usual method for sizing a whole duct run.</p>'+
        '<p><b>Rectangular duct</b> is sized to the ASHRAE/Huebscher equivalent-diameter equation, so it carries the same airflow at the same friction rate as the round duct shown — enter one side (usually the height, set by the ceiling space) and the calculator solves for the other.</p>'+
        '<p>This is an engineering estimate, accurate to within a few percent of a manufacturer\u2019s duct friction chart. For fire/smoke rated ducts, long runs, or code-mandated designs, verify against ASHRAE Fundamentals or the local mechanical code, This tool is for <b>air</b> duct only, not refrigerant piping. Keep rectangular ducts under about 4:1 (width : height) \u2014 flatter ducts need more metal and lose more pressure than the equivalent diameter suggests.</p>',
      onSeg:(gid, v)=>{
        if(gid==='ttMethod'){ $live('ttMethVel').style.display = v==='vel' ? '' : 'none'; $live('ttMethFric').style.display = v==='fric' ? '' : 'none'; }
        if(gid==='ttShape'){ $live('ttRectRow').style.display = v==='rect' ? '' : 'none'; }
      },
      calc:()=>{
        const cfm = cpNum('ttCfm');
        if(cfm <= 0){ cpResult('—', 'Recommended duct size', []); return; }
        const method = cpSegVal('ttMethod') || 'fric';
        const shape = cpSegVal('ttShape') || 'round';
        const dRound = method==='vel' ? ttDiaByVelocity(cfm, Math.max(1,cpNum('ttVel'))) : ttDiaByFriction(cfm, Math.max(0.001,cpNum('ttFric')));
        const vRoundFpm = ttVelocityFps(cfm, dRound)*60;
        const frAtRound = ttFrictionRate(cfm, dRound);
        if(shape==='round'){
          cpResult((Math.round(dRound*10)/10)+'" round', 'Recommended duct size', [
            Math.round(vRoundFpm).toLocaleString('en-PH')+' fpm',
            (Math.round(frAtRound*1000)/1000)+' in.wg / 100 ft'
          ]);
        } else {
          const a = Math.max(2, cpNum('ttSideA'));
          const b = ttRectOtherSide(a, dRound);
          const aFt2 = (a*b)/144;
          const vRectFpm = (cfm/aFt2);
          const aspect = Math.max(a, b) / Math.min(a, b);
          cpResult((Math.round(a*10)/10)+' × '+(Math.round(b*10)/10)+' in', 'Recommended duct size', [
            Math.round(vRectFpm).toLocaleString('en-PH')+' fpm',
            ...(aspect > 4 ? ['\u26A0 aspect ratio '+(Math.round(aspect*10)/10)+':1 \u2014 keep under 4:1'] : []),
            'equiv. '+(Math.round(dRound*10)/10)+'" round',
            (Math.round(frAtRound*1000)/1000)+' in.wg / 100 ft'
          ]);
        }
      }
    });
  }

  // =====================================================================
  // 2. Wire & breaker sizing — a real calculator (NEC/PEC 125%-of-rated-
  // current rule for motor-compressor circuits against the 60°C copper
  // ampacity column), exact given the nameplate current. (Reviewed: the
  // table was labelled 75°C but holds the 60°C values — label corrected.)
  // =====================================================================
  // [ampacity A, mm², AWG] — copper, 60°C column of NEC Table 310.16 (the
  // same values as PEC Table 3.10.1.16), ≤3 current-carrying conductors.
  // 60°C is the default for circuits up to 100 A / 14–1 AWG (NEC 110.14(C))
  // unless the equipment terminals are marked 75°C, so it is the safe choice
  // for aircon branch circuits; 14/12/10 AWG also sit at their 15/20/30 A
  // small-conductor limits (NEC 240.4(D)). The metric size shown is the PEC
  // size at or above the AWG cross-section.
  const TTE_AMPACITY = [
    [15,'2.0','14'],[20,'3.5','12'],[30,'5.5','10'],[40,'8.0','8'],[55,14,'6'],
    [70,22,'4'],[85,30,'3'],[95,38,'2'],[110,50,'1'],[125,60,'1/0'],
    [145,80,'2/0'],[165,100,'3/0'],[195,125,'4/0']
  ];
  // Standard molded-case breaker frame sizes (A).
  const TTE_BREAKERS = [15,20,30,40,50,60,70,80,90,100,110,125,150,175,200];
  function ttNextStd(list, value){ return list.find(v=> v >= value) || list[list.length-1]; }
  function ttCalcWireBreaker(){
    cpCalcHostTech = true;
    cpCalcShell('elecwire', {
      title:'Wire & breaker sizing',
      form:
        cpField('Nameplate FLA (or RLA + LRA-based MCA if given)', cpInput('teFla', 12, 'A', 'min="0" step="0.1"'), 'Use the equipment\u2019s Minimum Circuit Ampacity (MCA) if the nameplate gives one — it already includes the safety margin for motor loads.')+
        cpField('Nameplate already gives MCA?', cpSeg('teMca', [['no','No, this is FLA'],['yes','Yes, this is MCA']], 'no')),
      how:
        '<p>The branch-circuit wire for a motor-compressor is sized at <b>125% of its rated load current</b> (NEC 440.32, mirrored in the Philippine Electrical Code) — unless the nameplate states a <b>Minimum Circuit Ampacity (MCA)</b>, which already includes that margin.</p>'+
        '<p>Wire ampacity is read off the <b>60°C copper</b> column (≤3 current-carrying conductors in one raceway). 60°C is the rule for circuits up to 100 A unless the equipment terminals are marked 75°C (NEC 110.14(C)), so it is the safe default. A hotter ambient, more than 3 conductors bundled together, or a long run needing a voltage-drop upsize can call for a bigger wire than this minimum.</p>'+
        '<p>The breaker shown is the <b>smallest standard size at or above that ampacity</b>. The largest allowed is the <b>MOCP / Max. fuse on the nameplate</b> (up to 175% of the compressor rating — NEC 440.22); if the minimum breaker trips on start-up, go up toward that maximum, never past it.</p>'+
        '<p>This is a sizing reference, not a substitute for reading the equipment\u2019s own nameplate, or for a licensed electrician\u2019s sign-off where the installation requires one.</p>',
      calc:()=>{
        const fla = cpNum('teFla');
        if(fla <= 0){ cpResult('—', 'Minimum wire & breaker', []); return; }
        const isMca = cpSegVal('teMca') === 'yes';
        const design = isMca ? fla : fla*1.25;
        const wire = TTE_AMPACITY.find(w=> w[0] >= design) || TTE_AMPACITY[TTE_AMPACITY.length-1];
        const brk = ttNextStd(TTE_BREAKERS, design);
        cpResult(brk+'A breaker', 'Minimum branch circuit', [
          wire[1]+' mm² copper (AWG '+wire[2]+'), 60°C',
          'min. '+(Math.round(design*10)/10)+'A ampacity needed',
          'max. breaker = nameplate MOCP'
        ]);
      }
    });
  }

  // =====================================================================
  // 3. Reference tables (no live inputs) — a small shared shell.
  // =====================================================================
  function ttOpenTable(title, bodyHtml){
    cpCalcHostTech = false; // not used, but keep the flag sane
    $live('ttCalcTitle').textContent = title;
    const body = $live('ttCalcBody');
    body.oninput = null; body.onchange = null; body.onclick = null;
    body.innerHTML = bodyHtml;
    ttShowDetail();
  }
  const ttTbl = (head, rows)=> '<div class="adm-tbl-wrap"><table class="adm-tbl"><thead><tr>'+
    head.map(h=> '<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(r=> '<tr>'+r.map(c=> '<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';

  // ---- Heat load standards (BTU/hr) ----
  // ASHRAE Fundamentals, "Representative rates at which heat and moisture
  // are given off by human beings" (adjusted, mixed group). Reviewed: rows
  // were mislabelled (245/155 is "seated, very light work", 305/545 is
  // "moderate dancing", not heavy work) and "standing" was 200 latent.
  const TT_HEATLOAD_PEOPLE = [
    ['Seated, very light work (theater, reading)','245','155','400'],
    ['Office work, moderately active','250','200','450'],
    ['Standing, light work / walking','250','250','500'],
    ['Sedentary work (restaurant dining)','275','275','550'],
    ['Light bench work (factory)','275','475','750'],
    ['Moderate dancing','305','545','850'],
    ['Heavy work (factory, gym)','580','870','1450']
  ];
  const TT_HEATLOAD_EQUIP = [
    ['Desktop computer + monitor','500 – 650'],
    ['Laptop','100 – 150'],
    ['LCD/LED monitor (19–27")','100 – 170'],
    ['Laser printer (office)','500 – 1,000'],
    ['Photocopier, mid-size','1,000 – 3,000'],
    ['Photocopier, large / high-volume','4,000 – 6,000'],
    ['Small server / network rack','1,000 – 3,000+ (load-dependent)'],
    ['Microwave oven (running)','1,000 – 1,500'],
    ['Coffee maker (brewing)','1,000 – 1,700'],
    ['Water dispenser (hot & cold)','200 – 400'],
    ['Small office refrigerator (average)','400 – 800'],
    ['Television / large display','300 – 600']
  ];
  function ttOpenHeatLoad(){
    ttOpenTable('Heat load standards',
      '<div class="ct-card">'+
        '<p style="margin:0 0 10px;font-size:13.5px;color:var(--text-muted)">For load estimating — add these to the room\u2019s wall/glass/roof gains for a fuller picture, not a full ASHRAE load calculation. Figures are per person or per item; multiply by count.</p>'+
        '<p style="font-weight:700;margin:14px 0 6px">People (sensible / latent, BTU/hr per person)</p>'+
      '</div>'+
      ttTbl(['Activity level','Sensible','Latent','Total'], TT_HEATLOAD_PEOPLE)+
      '<div class="ct-card" style="margin-top:14px">'+
        '<p style="font-weight:700;margin:0 0 6px">Lighting</p>'+
        '<p style="margin:0 0 6px;font-size:13.5px">Heat gain = fixture wattage × <b>3.41 BTU/hr per watt</b>, then apply a ballast/driver factor:</p>'+
      '</div>'+
      ttTbl(['Lighting type','Factor on rated watts'], [
        ['Incandescent','× 1.0'],
        ['Fluorescent (with ballast)','× 1.25'],
        ['LED (with driver)','× 1.0 – 1.1']
      ])+
      '<div class="ct-card" style="margin-top:14px">'+
        '<p style="font-weight:700;margin:0 0 6px">Office & plug-load equipment (typical, diversified use)</p>'+
        '<p style="margin:0 0 6px;font-size:13.5px">For anything not listed: use the nameplate wattage × <b>3.41 BTU/hr per watt</b> (all electrical power used indoors ends up as heat), then discount for equipment that is not running continuously.</p>'+
      '</div>'+
      ttTbl(['Equipment','Typical heat gain (BTU/hr)'], TT_HEATLOAD_EQUIP)
    );
  }

  // ---- Refrigerant P-T chart ----
  const TT_PT_T = [-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,35,40,45,50,55,60,65];
  // Saturation pressure, kPa ABSOLUTE, every 5°C — from the CoolProp
  // reference equations of state (the Helmholtz-energy models REFPROP also
  // uses). Reviewed: the earlier Peng-Robinson fit was within ~1%; these are
  // the reference values. R-410A is a near-azeotropic blend (glide < 0.2 K)
  // shown at its bubble point.
  const TT_PT = {
    R22:[163.9,201.4,245.3,296.2,354.8,421.8,498,584.1,680.9,789.3,910,1043.9,1191.9,1354.8,1533.6,1729.2,1942.7,2175.1,2427.5,2701.2],
    R410A:[270.3,330.6,400.7,481.7,574.6,680.6,800.7,936.2,1088.3,1258.3,1447.5,1657.2,1889.1,2144.7,2425.6,2733.8,3071.1,3439.8,3842.6,4282.6],
    R32:[273.4,334.6,405.8,488.1,582.6,690.6,813.1,951.4,1106.9,1280.8,1474.6,1689.6,1927.5,2189.8,2478.3,2794.8,3141.2,3519.9,3933.2,4384.3],
    R134a:[84.4,106.4,132.7,163.9,200.6,243.3,292.8,349.7,414.6,488.4,571.7,665.4,770.2,887,1016.6,1159.9,1317.9,1491.5,1681.8,1889.8],
    R290:[167.8,203.4,244.5,291.6,345.3,406,474.5,551.1,636.6,731.5,836.5,952.1,1079,1217.9,1369.4,1534.3,1713.3,1907.2,2116.8,2343],
    R600a:[46.6,58.4,72.5,89.1,108.5,131,157,186.7,220.6,259,302.2,350.7,404.7,464.8,531.2,604.4,684.9,773,869.2,973.9]
  };
  const TT_PT_LABEL = {R22:'R-22',R410A:'R-410A',R32:'R-32',R134a:'R-134a',R290:'R-290 (propane)',R600a:'R-600a (isobutane)'};
  function ttPtRows(code){
    const kpa = TT_PT[code];
    return TT_PT_T.map((c,i)=>{
      const f = Math.round(c*9/5+32);
      const gaugeKpa = kpa[i]-101.325;
      const psig = gaugeKpa*0.145038;
      const psigTxt = psig<0 ? (Math.round(Math.abs(psig)*2.036*10)/10)+'" Hg vac' : (Math.round(psig*10)/10)+' psig';
      return [c+' / '+f+'°F', Math.round(kpa[i])+' kPa (abs)', psigTxt];
    });
  }
  function ttRenderPt(code){
    $live('ttPtBody').innerHTML = ttTbl(['°C / °F','Pressure (abs)','psig (or vacuum)'], ttPtRows(code));
  }
  function ttOpenPt(){
    ttOpenTable('Refrigerant pressures',
      '<div class="ct-card">'+
        '<p style="margin:0 0 10px;font-size:13.5px;color:var(--text-muted)">Saturation pressure vs. temperature. From reference equations of state (CoolProp) \u2014 matches a manufacturer P-T chart to within a fraction of a percent; still use the unit\u2019s own chart for anything critical. Negative gauge pressure is shown as vacuum.</p>'+
        '<div class="ct-chips" id="ttPtChips"></div>'+
      '</div><div id="ttPtBody"></div>'
    );
    const chips = $live('ttPtChips');
    const codes = Object.keys(TT_PT);
    chips.innerHTML = codes.map((c,i)=> '<button type="button" class="ct-chip'+(i===0?' on':'')+'" data-pt="'+c+'">'+TT_PT_LABEL[c]+'</button>').join('');
    chips.onclick = (e)=>{
      const b = e.target.closest('[data-pt]'); if(!b) return;
      $$('.ct-chip', chips).forEach(x=> x.classList.toggle('on', x===b));
      ttRenderPt(b.dataset.pt);
    };
    ttRenderPt(codes[0]);
  }

  // ---- Electrical standards reference (ranges — see the wire/breaker
  // calculator above for the exact, code-based sizing from a nameplate). ----
  const TT_ELEC_1PH = [
    ['0.5 HP','3 – 4 A','15 A','2.0 mm² (AWG 14)'],
    ['1.0 HP','5 – 7 A','15 A','2.0 mm² (AWG 14)'],
    ['1.5 HP','7 – 9 A','20 A','3.5 mm² (AWG 12)'],
    ['2.0 HP','9 – 11 A','20 A','3.5 mm² (AWG 12)'],
    ['2.5 HP','11 – 13 A','20 A','3.5 mm² (AWG 12)'],
    ['3.0 HP','13 – 16 A','30 A','5.5 mm² (AWG 10)']
  ];
  // Reviewed: the old ranges were ~20% low. These assume 1.0–1.3 kW of
  // input per TR (inverter to conventional) at a power factor of ~0.9.
  const TT_ELEC_TR = [
    ['5 TR','25 – 32 A','15 – 19 A','9 – 11 A'],
    ['7.5 TR','37 – 47 A','22 – 28 A','13 – 17 A'],
    ['10 TR','49 – 63 A (rare — usually 3-phase)','29 – 38 A','17 – 22 A']
  ];
  function ttOpenElectrical(){
    ttOpenTable('Electrical standards',
      '<div class="ct-card">'+
        '<p style="margin:0 0 10px;font-size:13.5px;color:var(--text-muted)">Typical ranges only — a starting point for planning, not a substitute for the equipment nameplate. For the exact minimum wire and breaker from a measured or nameplate FLA, use the Wire &amp; breaker sizing calculator.</p>'+
        '<p style="font-weight:700;margin:14px 0 6px">Window / split type, 230V single-phase</p>'+
      '</div>'+
      ttTbl(['Capacity','Typical FLA','Breaker','Wire (min.)'], TT_ELEC_1PH)+
      '<div class="ct-card" style="margin-top:14px">'+
        '<p style="font-weight:700;margin:0 0 6px">Packaged / ducted split, larger capacity — typical FLA by supply</p>'+
      '</div>'+
      ttTbl(['Capacity','230V 1-phase','230V 3-phase','380V 3-phase'], TT_ELEC_TR)+
      '<div class="ct-card" style="margin-top:14px">'+
        '<p style="font-weight:700;margin:0 0 6px">Control & communication wiring</p>'+
        '<ul style="margin:6px 0 0;padding-left:18px;font-size:13.5px;line-height:1.6">'+
          '<li><b>Room thermostat, 2–3 wire (24V):</b> 18 AWG (about 0.75–0.82 mm²) up to ~30 m; step up to 16 AWG for longer runs.</li>'+
          '<li><b>Multi-stage / communicating thermostat:</b> 18 AWG, 5–8 conductor thermostat cable, per the manufacturer\u2019s wiring diagram.</li>'+
          '<li><b>VRF/VRV indoor–outdoor communication:</b> commonly a 2-core shielded, twisted-pair cable, 0.75–2.0 mm² depending on total run length — <b>always follow the specific brand\u2019s installation manual</b>; this varies by manufacturer and run length more than any other wiring on the job.</li>'+
        '</ul>'+
        '<p style="margin:12px 0 0;font-size:12.5px;color:var(--text-muted)">Wire and breaker sizing here follows the 125%-of-rated-current rule for motor-compressor circuits (NEC 440.32 / Philippine Electrical Code) against the 60°C copper ampacity column. Always defer to the equipment nameplate\u2019s stated MCA and MOCP where given.</p>'+
      '</div>'
    );
  }

  // ---- Pipe sizing (refrigerant line OD, typical short-to-medium runs) ----
  // Reviewed against typical split / ducted manufacturer tables: the small
  // sizes were one step too big (an oversized suction line loses oil-return
  // velocity), and 1" is not a standard ACR tube size.
  const TT_PIPE = [
    ['0.75 – 1.0 HP (9,000 – 12,000 BTU/h)','1/4"','3/8"'],
    ['1.5 – 2.0 HP (12,000 – 18,000 BTU/h)','1/4"','1/2"'],
    ['2.5 – 3.0 HP (22,000 – 30,000 BTU/h)','3/8"','5/8"'],
    ['3 TR (36,000 BTU/h)','3/8"','5/8" – 3/4"'],
    ['4 – 5 TR (48,000 – 60,000 BTU/h)','3/8"','3/4"'],
    ['6 TR (72,000 BTU/h)','3/8" – 1/2"','7/8"'],
    ['7.5 TR (90,000 BTU/h)','1/2"','1 1/8"'],
    ['8 – 10 TR (96,000 – 120,000 BTU/h)','1/2" – 5/8"','1 1/8"']
  ];
  function ttOpenPipe(){
    ttOpenTable('Pipe sizing',
      '<div class="ct-card">'+
        '<p style="margin:0;font-size:13.5px;color:var(--text-muted)">Copper refrigeration tubing, liquid and suction line OD, for typical air-cooled split/ducted systems at normal equivalent pipe lengths (up to about 30 m / 50 ft with modest elevation change). Longer runs, big elevation differences, or multiple branch selectors change the sizing — always check the specific unit\u2019s installation manual, which is the final word for that model.</p>'+
      '</div>'+
      ttTbl(['Capacity','Liquid line OD','Suction line OD'], TT_PIPE)+
      '<div class="ct-card" style="margin-top:14px">'+
        '<p style="margin:0;font-size:13.5px">On long or vertical suction risers, line size can be reduced below the table value to keep velocity high enough for reliable oil return — this is a manufacturer/ASHRAE sizing decision, not something to change in the field without the install manual\u2019s riser chart.</p>'+
      '</div>'
    );
  }

  // =====================================================================
  // 4. Troubleshooting & error codes
  // =====================================================================
  const TT_TS_CATS = [['all','All'],['nocool','Not cooling'],['electrical','Electrical'],['noise','Noise / vibration'],['water','Water / drainage'],['codes','Error codes']];
  const TTUL = (items)=> '<ul style="margin:6px 0 0;padding-left:18px;line-height:1.7">'+items.map(i=> '<li>'+i+'</li>').join('')+'</ul>';
  const TT_TS = [
    { id:'nocool-compnostart', cat:'nocool', title:'Compressor hums but won\u2019t start', short:'Usually the run/start capacitor, overload, or a locked rotor.', body:[
      TTUL(['Check supply voltage at the unit — should be within ±10% of nameplate while the compressor tries to start.',
        'Check the run capacitor\u2019s µF against its rating (most read low, not zero, when weak) — replace if more than about 10% off or bulged.',
        'Check the overload/thermal protector — if it\u2019s open, let the compressor cool and re-test; repeated tripping points to a bigger problem, not a bad overload.',
        'Megger or resistance-check the compressor windings to ground and between windings (C-S, C-R, S-R) — a shorted or grounded winding means the compressor itself needs replacement.',
        'Rule out a stuck contactor or a mechanical lock (compressor won\u2019t turn at all) before condemning the compressor.']) ]},
    { id:'nocool-weakcool', cat:'nocool', title:'Runs but doesn\u2019t cool enough', short:'Dirty coil/filter, low refrigerant, or a restricted metering device.', body:[
      TTUL(['Filter and both coils clean? A dirty coil is the most common cause and the first thing to check.',
        'Check suction and discharge pressure against the P-T chart for the refrigerant in the system at the measured coil/ambient temperature.',
        'Low suction pressure with normal-to-low discharge often means low charge or a restriction (check for a frosted or cold spot along the liquid line — a sign of a restriction or TXV/capillary issue).',
        'High superheat with low subcooling points to undercharge; low superheat with high subcooling points to overcharge or a restriction downstream.',
        'Check indoor and outdoor fan speed and airflow — reduced airflow across either coil mimics a refrigerant problem.']) ]},
    { id:'nocool-icecoil', cat:'nocool', title:'Ice on the indoor coil', short:'Airflow restriction or low refrigerant — never just keep running it.', body:[
      'Turn the unit off and let the ice melt fully (fan-only or natural) before diagnosing — running a compressor against an iced coil risks liquid flooding back.',
      TTUL(['Check the filter and coil for blockage first — the most common cause.','Check blower speed/setting and duct static — restricted return air ices the coil.','Low charge also causes icing — verify against the P-T chart once the ice is cleared.','A failing or misadjusted TXV can starve the coil intermittently — watch superheat once running clean.']) ]},
    { id:'elec-trips', cat:'electrical', title:'Breaker trips on start or during run', short:'Locked rotor / high inrush, a short, or an undersized breaker.', body:[
      TTUL(['Trips instantly on start: check for a shorted winding or a locked/seized compressor (megger the windings; feel for the compressor trying to turn).',
        'Trips after running a while: check for a failing start/run capacitor forcing high running current, a dirty condenser raising head pressure and current, or a contactor with pitted contacts.',
        'Confirm the breaker itself is correctly sized (see the Wire & breaker sizing calculator) — an undersized breaker for the equipment\u2019s actual FLA will trip on legitimate startup current.',
        'Never simply upsize a breaker to stop tripping — sized wire and breaker protect the wire, not just the equipment; find the actual cause first.']) ]},
    { id:'elec-notpower', cat:'electrical', title:'Unit doesn\u2019t power on at all', short:'Check supply, fuse/breaker, and the low-voltage control circuit.', body:[
      TTUL(['Confirm line voltage at the disconnect/breaker first — no point troubleshooting the unit if it has no power.',
        'Check any inline fuse (common on the control transformer secondary) and the transformer itself for 24V output.',
        'A tripped high-pressure or float switch in the control circuit will hold the unit off exactly like a power loss — check these before assuming a control board fault.',
        'On inverter units, a PCB or communication fault can also present as "won\u2019t start" — check the unit\u2019s error code display before replacing parts.']) ]},
    { id:'noise-rattle', cat:'noise', title:'Rattling or buzzing noise', short:'Loose panel, mounting, or a failing fan/compressor mount.', body:[
      TTUL(['Loose screws or panels are the most common and the first thing to rule out.','Check fan blade for a bent tip or debris hitting it.','Check compressor rubber mounts/grommets for wear — a compressor riding metal-to-metal buzzes and vibrates through the cabinet.','A buzzing contactor usually means a worn or dirty contact, or low control voltage.']) ]},
    { id:'noise-hiss', cat:'noise', title:'Hissing or gurgling in the line', short:'Hissing at the TXV/cap tube is normal; elsewhere it may be a leak.', body:[
      'A soft hiss right at the metering device (TXV or capillary tube) is normal refrigerant flow noise.',
      TTUL(['A hiss anywhere else along the line — especially at a flare, braze joint, or valve — check for a leak with a detector or soap bubbles.','Gurgling at the indoor coil inlet can mean flash gas from a low charge or a restriction upstream.']) ]},
    { id:'water-drip', cat:'water', title:'Water dripping from the indoor unit', short:'Almost always a blocked or poorly pitched drain line.', body:[
      TTUL(['Clear the drain line first — algae/sludge blockage is by far the most common cause.','Check the drain pan for cracks and correct pitch/level.','Check that the condensate pump (if fitted) actually lifts water — listen/feel for it cycling.','On rare cases, check that the coil isn\u2019t icing (see above) — melting ice can overwhelm a pan that\u2019s otherwise fine.']) ]},
    { id:'water-outdoor', cat:'water', title:'Water pooling under the outdoor unit', short:'Usually normal condensate/defrost — confirm it isn\u2019t a leak.', body:[
      'Some water under the outdoor unit during or after a defrost cycle, or from a humid indoor coil\u2019s condensate routed outside, is normal.',
      TTUL(['Confirm it\u2019s only water, not oil-streaked refrigerant residue, which points to a leak instead.','Check the base pan drain isn\u2019t blocked by debris, causing standing water and corrosion.']) ]},
    { id:'codes-daikin', cat:'codes', title:'Daikin — common error codes', short:'A-, C-, E-, F-, H-, J-, L-, P- and U-series codes on split and VRV units.', body:[
      'Meanings below are the ones commonly shared across Daikin split and VRV/VRF models — the exact list for a specific unit is on its label or service manual; confirm there before acting.',
      TTUL(['<b>A1</b> — indoor PCB fault. <b>A3</b> — drain level / drain pump fault. <b>A5</b> — freeze-up or high-pressure control (indoor coil). <b>A6</b> — indoor fan motor lock / fault. <b>A9</b> — indoor electronic expansion valve (EEV) fault.',
        '<b>C4</b> — indoor heat-exchanger (liquid pipe) thermistor. <b>C5</b> — indoor heat-exchanger (gas pipe) thermistor. <b>C9</b> — indoor suction-air (room) thermistor.',
        '<b>E1</b> — outdoor PCB fault. <b>E3</b> — high-pressure trip. <b>E4</b> — low-pressure trip. <b>E5</b> — compressor lock / overheat. <b>E6</b> — compressor start-up / over-current. <b>E7</b> — outdoor fan motor fault. <b>E9</b> — outdoor EEV fault.',
        '<b>F3</b> — discharge pipe high temperature. <b>F6</b> — high-pressure control in cooling.',
        '<b>H3</b> — high-pressure switch fault. <b>H6</b> — compressor position-detection fault. <b>H9</b> — outdoor air thermistor.',
        '<b>J3</b> — discharge pipe thermistor. <b>J5</b> — suction pipe thermistor. <b>J6</b> — outdoor heat-exchanger thermistor (J-series are outdoor thermistor faults).',
        '<b>L4</b> — inverter fin (radiator) high temperature. <b>L5</b> — inverter compressor over-current. <b>P4</b> — fin thermistor fault.',
        '<b>U0</b> — refrigerant shortage. <b>U2</b> — power supply voltage fault. <b>U4</b> — indoor–outdoor transmission fault. <b>U5</b> — remote controller transmission fault.']) ]},
    { id:'codes-carrier', cat:'codes', title:'Midea-built inverter (incl. Carrier / Toshiba-Carrier rebadges) — common codes', short:'E0–E6 and P0–P4 codes used on many Midea-platform splits.', body:[
      'Many inverter splits built on the Midea platform (sold under several brand names) share these codes, but the numbering changed between generations — always confirm against the specific model\u2019s manual before replacing parts.',
      TTUL(['<b>E0</b> — EEPROM (memory) fault.','<b>E1</b> — indoor–outdoor communication fault.','<b>E2</b> — zero-crossing detection fault (indoor PCB / power).','<b>E3</b> — indoor fan speed out of control.','<b>E4</b> — indoor room temperature sensor (T1) open or short.','<b>E5</b> — indoor coil temperature sensor (T2) open or short.','<b>E6</b> — outdoor coil sensor (T3) or outdoor fault, varies by model.','<b>P0</b> — IPM module / inverter protection.','<b>P1</b> — over- or under-voltage protection.','<b>P2</b> — compressor top (discharge) high-temperature protection.','<b>P4</b> — inverter compressor drive fault.']) ]},
    { id:'codes-lg', cat:'codes', title:'LG — common CH error codes', short:'CH numbers shown on the indoor unit or remote display.', body:[
      'LG\u2019s \u201CCH\u201D (check) codes repeat across most split and multi models — confirm the exact list against the unit\u2019s manual.',
      TTUL(['<b>CH01</b> — indoor room (air) temperature sensor.','<b>CH02</b> — indoor coil inlet pipe sensor.','<b>CH03</b> — wired remote controller communication.','<b>CH04</b> — drain / float switch.','<b>CH05</b> — indoor–outdoor communication error.','<b>CH06</b> — indoor coil outlet pipe sensor.','<b>CH10</b> — indoor fan (BLDC) motor lock.','<b>CH21</b> — inverter DC peak / IPM fault.','<b>CH22</b> — input over-current (CT).','<b>CH23</b> — DC-link voltage too low.','<b>CH32</b> — discharge pipe temperature too high.','<b>CH41</b> — discharge pipe sensor.','<b>CH44</b> — outdoor air sensor.','<b>CH45</b> — outdoor coil (condenser) sensor.','<b>CH61</b> — outdoor coil temperature too high.','<b>CH67</b> — outdoor fan (BLDC) motor lock.']) ]},
    { id:'codes-samsung', cat:'codes', title:'Samsung — common error codes', short:'E1xx (indoor), E2xx / E4xx (outdoor) numbering used on many split models.', body:[
      'Samsung splits group indoor faults under E1xx and outdoor faults under E2xx and E4xx — confirm the specific digits against the unit\u2019s manual.',
      TTUL(['<b>E101</b> — indoor–outdoor communication error.','<b>E121</b> — indoor room temperature sensor.','<b>E122</b> — indoor coil (evaporator inlet) sensor.','<b>E154</b> — indoor fan motor error.','<b>E162</b> — indoor EEPROM error.','<b>E201</b> — outdoor communication error (wiring / installation).','<b>E221</b> — outdoor air temperature sensor.','<b>E237</b> — outdoor coil (condenser) sensor.','<b>E251</b> — discharge pipe sensor.','<b>E416</b> — discharge temperature too high.','<b>E458</b> — outdoor fan motor error.','<b>E461</b> — compressor start-up failure.','<b>E464</b> — inverter IPM over-current.']) ]}
  ];
  let ttTsCat = 'all';
  function ttRenderTsList(q){
    q = (q||'').toLowerCase();
    const list = $live('ttTsList');
    list.innerHTML = TT_TS.filter(t=> (ttTsCat==='all' || t.cat===ttTsCat) &&
        (!q || (t.title+' '+t.short).toLowerCase().includes(q))
      ).map(t=> '<button type="button" class="ct-tip" data-ts="'+t.id+'">'+
        '<span class="ct-text"><span class="ct-tip-t">'+escapeHtml(t.title)+'</span><span class="ct-tip-d">'+escapeHtml(t.short)+'</span></span>'+
        '<span class="ct-chev">\u203a</span></button>').join('') || '<p class="ct-empty">Nothing matches.</p>';
  }
  function ttOpenTsArticle(id){
    const t = TT_TS.find(x=> x.id===id); if(!t) return;
    $live('ttCalcTitle').textContent = t.title;
    const body = $live('ttCalcBody');
    body.oninput = null; body.onchange = null;
    body.innerHTML = '<div class="ct-card ct-article"><p class="ct-lead">'+escapeHtml(t.short)+'</p>'+
      t.body.map(b=> b.trim().startsWith('<ul')||b.trim().startsWith('Turn') ? (b.startsWith('<ul')?b:'<p>'+b+'</p>') : '<p>'+b+'</p>').join('')+
      '</div><button type="button" class="ct-back" id="ttTsBackToList" style="margin-top:12px">\u2039 Troubleshooting list</button>';
    body.onclick = (e)=>{ if(e.target.closest('#ttTsBackToList')) ttOpenTroubleshoot(); };
    ttShowDetail();
  }
  function ttOpenTroubleshoot(){
    $live('ttCalcTitle').textContent = 'Troubleshooting & error codes';
    const body = $live('ttCalcBody');
    body.innerHTML =
      '<label class="ct-search"><span>'+icon('search')+'</span><input type="search" id="ttTsSearch" placeholder="Search symptoms or codes" autocomplete="off"></label>'+
      '<div class="ct-chips" id="ttTsChips" style="margin-top:12px"></div>'+
      '<div class="ct-card ct-list" id="ttTsList" style="margin-top:10px"></div>';
    $live('ttTsChips').innerHTML = TT_TS_CATS.map(([k,l])=> '<button type="button" class="ct-chip'+(k===ttTsCat?' on':'')+'" data-cat="'+k+'">'+l+'</button>').join('');
    body.oninput = ()=> ttRenderTsList($live('ttTsSearch').value);
    body.onclick = (e)=>{
      const chip = e.target.closest('[data-cat]');
      if(chip){ ttTsCat = chip.dataset.cat; $$('.ct-chip', $live('ttTsChips')).forEach(b=> b.classList.toggle('on', b===chip)); ttRenderTsList($live('ttTsSearch').value); return; }
      const item = e.target.closest('[data-ts]');
      if(item) ttOpenTsArticle(item.dataset.ts);
    };
    ttRenderTsList('');
    ttShowDetail();
  }

  // =====================================================================
  // Grid
  // =====================================================================
  const TT_CALCULATORS = [
    { id:'ductulator', icon:'ruler', title:'Ductulator', desc:'Round & rectangular duct sizing', run:ttCalcDuctulator },
    { id:'elecwire', icon:'bolt', title:'Wire & breaker sizing', desc:'From nameplate FLA / MCA (NEC/PEC rule)', run:ttCalcWireBreaker }
  ];
  const TT_TABLES = [
    { id:'heatload', icon:'flame', title:'Heat load standards', desc:'BTU/hr — people, lighting, equipment', run:ttOpenHeatLoad },
    { id:'pt', icon:'snowflake', title:'Refrigerant pressures', desc:'P-T chart — R22, R410A, R32 & more', run:ttOpenPt },
    { id:'electrical', icon:'bolt', title:'Electrical standards', desc:'Breaker & wire size per TR/HP', run:ttOpenElectrical },
    { id:'pipe', icon:'ruler', title:'Pipe sizing', desc:'Liquid & suction line size, 1 HP – 10 TR', run:ttOpenPipe },
    { id:'troubleshoot', icon:'toolbox', title:'Troubleshooting & codes', desc:'Symptoms, checks, and error code meanings', run:ttOpenTroubleshoot }
  ];
  const TT_ICON_TONE = { ruler:'teal', bolt:'amber', flame:'rose', snowflake:'blue', toolbox:'green' };
  function ttTile(c){
    return '<button type="button" class="ct-calc" data-tt="'+c.id+'">'+
      '<span class="ct-ic ct-'+(TT_ICON_TONE[c.icon]||'teal')+'">'+icon(c.icon)+'</span>'+
      '<span class="ct-calc-t">'+c.title+'</span><span class="ct-calc-d">'+c.desc+'</span></button>';
  }
  function ttRenderGrid(){
    $live('ttSearchIc').innerHTML = icon('search');
    $live('ttCalcGrid').innerHTML = TT_CALCULATORS.map(ttTile).join('');
    $live('ttTableGrid').innerHTML = TT_TABLES.map(ttTile).join('');
    ttFilterGrid();
  }
  function ttFilterGrid(){
    const q = ($live('ttSearch').value||'').trim().toLowerCase();
    let shown = 0;
    $$('.ct-calc', $('ttToolsScreen')).forEach(el=>{
      const ok = !q || el.textContent.toLowerCase().includes(q);
      el.style.display = ok ? '' : 'none'; if(ok) shown++;
    });
    $live('ttGridEmpty').style.display = shown ? 'none' : '';
  }
  const ttSearchEl = $('ttSearch');
  if(ttSearchEl) ttSearchEl.addEventListener('input', ttFilterGrid);
  const ttToolsScreenEl = $('ttToolsScreen');
  if(ttToolsScreenEl) ttToolsScreenEl.addEventListener('click', (e)=>{
    const c = e.target.closest('[data-tt]'); if(!c) return;
    const all = TT_CALCULATORS.concat(TT_TABLES);
    const item = all.find(x=> x.id===c.dataset.tt);
    if(item) item.run();
  });
