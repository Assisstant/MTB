/* Shared administration over PostgreSQL. Drafts live only in this page's DOM;
 * changing windows does not discard them and nothing is saved to localStorage. */
(() => {
  'use strict';
  const ctx=window.MTBWorkspaceContext;if(!ctx)return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const roles={teacher:'Учествува во настава',therapist:'Учествува во кабинетски распоред',specialist:'Стручен соработник / служба',administration:'Администрација'};
  const programmes={unknown:'Непотврдено',standard:'Стандардна',modified:'Модифицирана'};
  const placements={unknown:'Непотврдено',regular:'Редовна настава',preparatory:'Подготвителна група',observation:'Опсервација',none:'Само услуги · без локална настава'};
  const roman=['I','II','III','IV','V','VI','VII','VIII','IX'];
  const option=(value,label,selected)=>`<option value="${esc(value)}"${String(value)===String(selected)?' selected':''}>${esc(label)}</option>`;
  const options=(items,value)=>Object.entries(items).map(([k,v])=>option(k,v,value)).join('');
  const root=document.createElement('section');root.id='masterAdmin';root.hidden=true;root.setAttribute('aria-label','Администрација на MTB');
  root.innerHTML=`<header class="ma-heading"><div><h1>Администрација</h1><div class="ma-caption">Еден ученик. Еден вработен. Поврзани податоци за секоја учебна година.</div></div><div class="ma-actions"><label>Учебна година <select id="maYear" aria-label="Учебна година за администрација"></select></label><button id="maReload">Освежи</button><button id="maClose">Назад кон прозорците</button></div></header><div class="ma-bar"><button data-ma-tab="pupils" aria-pressed="true">Ученици</button><button data-ma-tab="employees" aria-pressed="false">Вработени</button><button data-ma-open="Podatoci.html">Паралелки / предмети</button><span id="maStatus" role="status" aria-live="polite">Се поврзувам со базата…</span></div><div class="ma-body"><aside class="ma-list-panel"><div class="ma-filters"><label class="ma-wide">Пребарај<input id="maSearch" type="search" autocomplete="off" placeholder="Име, паралелка или идентификатор"></label><label>Статус<select id="maActive">${options({active:'Активни',all:'Сите',inactive:'Неактивни'},'active')}</select></label><label id="maKindLabel">Упис<select id="maKind">${options({'':'Сите',internal:'Внатрешни',external:'Надворешни'},'')}</select></label><label id="maClassLabel">Паралелка<select id="maClass"></select></label><label id="maGradeLabel">Одделение<select id="maGrade">${option('','Сите','')+roman.map(x=>option(x,x,'')).join('')}</select></label><label class="ma-wide" id="maTherapistLabel">Терапевт<select id="maTherapist"></select></label><button id="maAdd" class="ma-wide">＋ Додај ученик</button></div><div id="maList" class="ma-list" aria-label="Список"></div></aside><article id="maDetail" class="ma-detail"><div class="ma-empty">Изберете запис од списокот.</div></article></div>`;
  document.querySelector('.main').append(root);
  root.querySelector('.ma-filters').insertAdjacentHTML('beforeend','<label id="maProfessionLabel" hidden>Професија<select id="maProfession"></select></label><label id="maDutyLabel" hidden>Задолжение<select id="maDuty"></select></label>');
  const toggle=document.createElement('button');toggle.type='button';toggle.className='primary';toggle.id='openMasterAdmin';toggle.textContent='Администрација';toggle.setAttribute('aria-controls',root.id);toggle.setAttribute('aria-expanded','false');document.querySelector('.topbar').prepend(toggle);
  const $=id=>root.querySelector('#'+id);
  let data=null,tab='pupils',selected=null,dirty=false,busy=false,year='',base='',ticket=0,readonly=false;
  const status=(message,kind='')=>{$('maStatus').textContent=message;$('maStatus').className=kind?'ma-'+kind:'';};
  const canDiscard=()=>!dirty||confirm('Има незачуван внес. Да се отфрли и да се продолжи?');
  const employeeRoles=e=>[...(e.teacher_active?['teacher']:[]),...(e.therapist_active?['therapist']:[]),...e.additional_roles];
  const pupilActive=p=>p.globally_active&&p.annual_active;
  const rows=()=>data?data[tab]:[];
  const idOf=row=>tab==='pupils'?row.public_id:row.id;
  function close(){root.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();}
  function launch(file){ctx.useYear(year);if(selected)ctx.focus((tab==='pupils'?'student:':selected.therapist_id?'therapist:':'teacher:')+(tab==='pupils'?selected.public_id:selected.therapist_id||selected.teacher_id||''));const button=document.querySelector(`#appTabs [data-app="${file}"]`);if(button){close();button.click();}}
  function applyReadonly(){
    root.querySelectorAll('[data-ma-write],#maAdd').forEach(n=>n.disabled=readonly||busy||!data);
    root.querySelectorAll('form input,form select,#maLinkSource,#maCancel').forEach(n=>n.disabled=readonly||busy);
    $('maYear').disabled=busy;
    const fieldset=$('maForm')?.querySelector('fieldset');if(fieldset)fieldset.disabled=readonly||busy||selected?.globally_active===false;
  }
  async function load(wanted){
    if(busy)return;const mine=++ticket;status('Вчитувам од базата…');
    try{
      const years=await ctx.request('GET','/api/years');if(mine!==ticket)return;
      const chosen=wanted||year||ctx.year()||(years.find(y=>y.is_current)||years[0])?.label;
      if(!chosen)throw Error('Нема учебна година.');
      const server=ctx.server();
      const [next,health]=await Promise.all([ctx.request('GET','/api/workspace?year='+encodeURIComponent(chosen)),ctx.request('GET','/api/health')]);
      if(mine!==ticket||server!==ctx.server())return;
      year=chosen;base=server;data=next;readonly=health.mirror?.mode==='readonly';
      $('maProfession').innerHTML=option('','Сите','')+options(data.staffProfessions||{},'');
      $('maDuty').innerHTML=option('','Сите','')+options(data.staffDuties||{},'');
      $('maYear').innerHTML=years.map(y=>option(y.label,y.label+(y.is_current?' · тековна':' · архива'),year)).join('');
      $('maClass').innerHTML=option('','Сите','')+option('__none','Без паралелка','')+data.classes.map(c=>option(c.label,c.label,'')).join('');
      $('maTherapist').innerHTML=option('','Сите','')+data.employees.filter(e=>e.therapist_active).map(e=>option(e.therapist_id,e.name,'')).join('');
      selected=selected&&rows().find(r=>String(idOf(r))===String(idOf(selected)))||null;dirty=false;renderList();renderDetail();
      status(readonly?'Локална копија · само читање':`${year} · PostgreSQL · ${data.pupils.filter(pupilActive).length} активни ученици`);applyReadonly();
    }catch(e){status(e.message,'error');$('maYear').value=year;}
  }
  function renderList(){
    const query=$('maSearch').value.trim().toLocaleLowerCase('mk-MK'),active=$('maActive').value;
    const matches=rows().filter(r=>{
      const on=tab==='pupils'?pupilActive(r):employeeRoles(r).length>0;
      if(active==='active'&&!on||active==='inactive'&&on)return false;
      if(![r.name,r.grade,r.identifier,r.job_title,data.staffProfessions?.[r.profession_code],...(r.duties||[]).map(k=>data.staffDuties?.[k])].filter(Boolean).join(' ').toLocaleLowerCase('mk-MK').includes(query))return false;
      if(tab==='employees')return (!$('maProfession').value||(r.profession_code||'unknown')===$('maProfession').value)&&(!$('maDuty').value||(r.duties||[]).includes($('maDuty').value));
      const cls=$('maClass').value;
      return (!$('maKind').value||r.enrollment_type===$('maKind').value)&&(!cls||(cls==='__none'?!r.grade:r.grade===cls))&&(!$('maGrade').value||r.oddelenie===$('maGrade').value)&&(!$('maTherapist').value||r.therapists.some(t=>String(t.id)===$('maTherapist').value));
    });
    $('maList').innerHTML=matches.length?matches.map(r=>`<button type="button" data-ma-id="${esc(idOf(r))}" aria-pressed="${selected&&idOf(r)===idOf(selected)?'true':'false'}"><strong>${esc(r.name)}</strong><small>${tab==='pupils'?esc([r.grade||'Без паралелка',r.oddelenie&&'Одд. '+r.oddelenie,r.enrollment_type==='external'?'Надворешен':'Внатрешен',r.boarding&&'Интернат',!pupilActive(r)&&'Неактивен'].filter(Boolean).join(' · ')):esc([data.staffProfessions?.[r.profession_code],...(r.duties||[]).map(k=>data.staffDuties?.[k]),employeeRoles(r).map(k=>roles[k]).join(' · ')||'Без активна улога',!r.teacher_active&&!r.therapist_active&&'Без учество во распоред'].filter(Boolean).join(' · '))}</small></button>`).join(''):'<div class="ma-empty">Нема записи за избраните филтри.</div>';
  }
  const field=(label,name,value,type='text')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${name==='name'?'required maxlength="120"':'maxlength="80"'}></label>`;
  const select=(label,name,items,value)=>`<label>${label}<select name="${name}">${options(items,value)}</select></label>`;
  function renderDetail(){
    if(!selected){$('maDetail').innerHTML='<div class="ma-empty">Изберете запис или додајте нов. Податоците се зачувуваат само по потврда од PostgreSQL.</div>';return;}
    const r=selected,isNew=!r.expected;
    let html=`<h2>${esc(isNew?(tab==='pupils'?'Нов ученик':'Нов вработен'):r.name)}</h2><div class="ma-sub">${esc(year)} · ${tab==='pupils'?'Постојан идентитет, одделни годишни податоци.':'Една личност може да има повеќе годишни улоги.'}</div><form id="maForm" class="ma-form"><fieldset style="border:0;padding:0;margin:0" ${readonly||r.globally_active===false?'disabled':''}><div class="ma-section"><h3>Основни податоци</h3><div class="ma-grid">${field('Име и презиме','name',r.name)}`;
    if(tab==='pupils'){
      const classOptions={'':'Без локална паралелка',...Object.fromEntries(data.classes.map(c=>[c.label,c.label]))};if(r.grade&&!classOptions[r.grade])classOptions[r.grade]=r.grade+' · неактивна';
      html+=select('Одделение на ученикот','oddelenie',{'':'Непотврдено',...Object.fromEntries(roman.map(x=>[x,x]))},r.oddelenie||'')+select('Паралелка / група','grade',classOptions,r.grade||'')+select('Основен статус','enrollmentType',{internal:'Внатрешен',external:'Надворешен'},r.enrollment_type)+select('Програма','programme',programmes,r.programme)+select('Локална настава / поставеност','placement',placements,r.placement)+`</div><div class="ma-checks" style="margin-top:18px"><label><input name="boarding" type="checkbox" ${r.boarding?'checked':''}>Користи интернат</label><label><input name="active" type="checkbox" ${r.annual_active?'checked':''}>Активен во ${esc(year)}</label></div><p class="ma-hint">Интернатот е независен од програмата. Надворешен ученик добива локална паралелка само со експлицитна модифицирана програма, подготвителна група или опсервација. Исклучувањето од година не ја брише историјата.</p>`;
    }else{
      html+=field('Идентификатор на вработен · незадолжително','identifier',r.identifier)+`</div><h3>Професија и задолженија · ${esc(year)}</h3>`;
      if(data.staffProfessions&&data.staffDuties){
        html+=`<div class="ma-grid">${select('Професија / стручно звање','professionCode',data.staffProfessions,r.profession_code||'unknown')}<label>Работно место · незадолжително<input name="jobTitle" maxlength="200" value="${esc(r.job_title||'')}"></label></div><fieldset class="ma-duty-group"><legend>Годишни задолженија · може повеќе</legend><div class="ma-checks">${Object.entries(data.staffDuties).map(([k,v])=>`<label><input type="checkbox" name="duties" value="${esc(k)}" ${(r.duties||[]).includes(k)?'checked':''}>${esc(v)}</label>`).join('')}</div></fieldset><p class="ma-hint">Непотврдено / без избрано задолжение значи дека податокот сè уште не е внесен. Професијата и задолжението сами не додаваат лице во распоред.</p>`;
      }else html+='<p class="ma-hint">Овој сервер сè уште нема поддршка за професија и годишни задолженија. Потребна е надградба; овие податоци не се зачувуваат привидно.</p>';
      html+=`<h3>Учество во распоред и годишни улоги</h3><div class="ma-checks">${Object.entries(roles).map(([k,v])=>`<label><input type="checkbox" name="roles" value="${k}" ${employeeRoles(r).includes(k)?'checked':''}>${v}</label>`).join('')}</div><div class="ma-grid" style="margin-top:16px">${select('Основен наставнички профил','teacherKind',{none:'Не е наставник · кабинет или служба',odd:'Одделенски',pred:'Предметен'},r.teacher_kind||'none')}</div><p class="ma-hint" id="maKindNote"></p><p class="ma-hint">„Не е наставник“ е за вработен без настава — кабинет, стручна служба или администрација; тогаш нема наставнички профил воопшто. Со „Учествува во настава“ профилот мора да биде одделенски или предметен, зашто распоредот на наставата се чита поинаку за секој од двата. За вработен без распоред изберете „Стручен соработник / служба“ или „Администрација“, без двете полиња за учество. „Учествува во кабинетски распоред“ го вклучува лицето во Fusion; не создава термини и не доделува пристап. Без избрани улоги лицето е неактивно за оваа година; историјата останува.</p><p class="ma-hint">Категорија за услуги / акциски план: настава — ${esc(r.teacher_category||'Недоделена')}; кабинет — ${esc(r.therapist_category||'Недоделена')}. Се уредува преку постојниот избор во „Податоци“, одделно од професијата.</p><p class="ma-hint">Модифицираната програма и подготвителната група се избираат и на секој ученик, со неговиот статус и паралелка. Овде се евидентира задолжението, не се создава групен кабинетски термин.</p>`;
    }
    html+=`</div><div class="ma-footer"><button class="ma-save" data-ma-write type="submit">Зачувај во базата</button><button type="button" id="maCancel">Откажи внес</button><span id="maSaved" role="status" class="ma-hint">${r.globally_active===false?'Глобално архивиран · проверете ја архивата во S-Дневник.':'Промената на името важи за сите години.'}</span></div></fieldset></form>`;
    if(!isNew&&tab==='pupils'){
      html+=`<section class="ma-section"><h3>Терапевти и услуги</h3><form id="maCaseload"><div class="ma-checks">${data.employees.filter(e=>e.therapist_active||r.therapists.some(t=>t.id===e.therapist_id)).map(e=>`<label><input name="therapist" type="checkbox" value="${e.therapist_id}" ${r.therapists.some(t=>t.id===e.therapist_id)?'checked':''}>${esc(e.name)}${e.therapist_active?'':' · неактивен'}</label>`).join('')||'<span class="ma-hint">Нема активни терапевти.</span>'}</div><div class="ma-footer"><button data-ma-write type="submit">Зачувај терапевти</button><span class="ma-hint">Постојните термини прво се уредуваат во кабинетскиот распоред.</span></div></form></section><section class="ma-section"><h3>Годишна историја</h3><button id="maHistory">Прикажи паралелки и годишни податоци</button><div id="maHistoryResult"></div></section>`;
    }
    if(!isNew&&tab==='employees')html+=`<details class="ma-section"><summary>Поврзи постоен наставнички / терапевтски идентитет</summary><p class="ma-hint">Само по човечка проверка дека е истата личност. Исто име не е доказ. Профилите и нивната историја се задржуваат; избраниот запис се поврзува со овој.</p><select id="maLinkSource" aria-label="Постоен вработен за поврзување">${option('','Изберете потврден идентитет','')+data.employees.filter(e=>e.id!==r.id).map(e=>option(e.id,e.name+' · #'+e.id,'')).join('')}</select><button id="maLink" data-ma-write>Поврзи со овој запис</button></details>`;
    if(!isNew&&tab==='employees'&&data.staffProfessions)html+='<section class="ma-section"><h3>Годишна историја на задолженија</h3><button id="maEmployeeHistory">Прикажи професија и задолженија по година</button><div id="maEmployeeHistoryResult"></div></section>';
    html+=`<h3>Поврзана работа</h3><div class="ma-links"><button data-ma-open="RasporediFusion.html">Кабинетски распоред</button><button data-ma-open="NastavaUredi.html">Настава / предмети</button><button data-ma-open="Podatoci.html">Паралелки / списоци</button><button data-ma-open="AkciskiPlan.html">Евидентен лист</button></div><p class="ma-hint">Веќе отворените прозорци ги задржуваат својата година и внесот. Освежете ги таму по зачувана корекција, кога нема незачувани промени.</p>`;
    $('maDetail').innerHTML=html;applyReadonly();syncKindNote();
    $('maForm').addEventListener('submit',savePerson);
    $('maCaseload')?.addEventListener('submit',saveCaseload);
  }
  /* Says it BEFORE the save is refused, and never rewrites the choice: a
   * field that quietly resets itself while somebody is reading it is how a
   * profile gets emptied by a press of Save meant for something else. */
  function syncKindNote(){
    const note=$('maKindNote'),form=$('maForm');if(!note||!form)return;
    const teaches=[...form.querySelectorAll('input[name=roles]')].some(n=>n.value==='teacher'&&n.checked);
    const kind=form.elements.teacherKind?.value;
    note.textContent=teaches&&kind==='none'?'Со „Учествува во настава“ изберете одделенски или предметен — инаку зачувувањето ќе биде одбиено.'
      :!teaches&&kind!=='none'?'Профилот се памети, но без „Учествува во настава“ лицето не е во наставата оваа година.':'';
    note.className=teaches&&kind==='none'?'ma-hint ma-error':'ma-hint';
  }
  function inputChanged(){dirty=true;status('Незачуван внес · останува во отворениот прозорец.');}
  async function write(path,body,method){
    if(readonly)throw Error('Локалната копија е само за читање.');
    if(base!==ctx.server())throw Error('Серверот е сменет. Задржете го внесот и освежете пред зачувување.');
    busy=true;applyReadonly();
    try{return await ctx.request(method,path,body);}finally{busy=false;applyReadonly();}
  }
  function saved(row){const id=idOf(row),index=rows().findIndex(r=>idOf(r)===id);if(index<0)rows().push(row);else rows()[index]=row;selected=row;dirty=false;renderList();renderDetail();status('Зачувано и потврдено од PostgreSQL.','success');}
  async function savePerson(event){event.preventDefault();if(busy)return;
    // A caseload draft is a separate transaction. Do not silently discard it.
    const assignments=$('maCaseload');
    if(assignments&&Array.from(assignments.querySelectorAll('input:checked')).map(n=>Number(n.value)).sort().join(',')!==selected.therapists.map(t=>t.id).sort().join(',')){status('Прво зачувајте или вратете го изборот на терапевти.','error');return;}
    const f=new FormData($('maForm'));const body={year,name:String(f.get('name')).trim(),...(selected.expected?{expected:selected.expected}:{})};
    if(tab==='pupils')Object.assign(body,{grade:f.get('grade')||null,oddelenie:f.get('oddelenie')||null,enrollmentType:f.get('enrollmentType'),boarding:f.has('boarding'),programme:f.get('programme'),placement:f.get('placement'),active:f.has('active')});
    else {Object.assign(body,{identifier:f.get('identifier')||null,roles:f.getAll('roles'),teacherKind:f.get('teacherKind')});if(data.staffProfessions&&data.staffDuties)Object.assign(body,{professionCode:f.get('professionCode'),jobTitle:f.get('jobTitle')||'',duties:f.getAll('duties')});}
    try{const out=await write('/api/workspace/'+tab+(selected.expected?'/'+encodeURIComponent(idOf(selected)):''),body,selected.expected?'PUT':'POST');saved(out.pupil||out.employee);}catch(e){status(e.message,'error');}
  }
  async function saveCaseload(event){event.preventDefault();if(busy)return;
    // Preserve the other form: compare it with its untouched default state.
    if([...$('maForm').elements].some(n=>n.tagName==='INPUT'?(n.type==='checkbox'?n.checked!==n.defaultChecked:n.value!==n.defaultValue):n.tagName==='SELECT'&&n.value!==[...n.options].find(o=>o.defaultSelected)?.value)){status('Прво зачувајте или откажете ги основните податоци.','error');return;}
    try{const out=await write('/api/workspace/pupils/'+encodeURIComponent(selected.public_id)+'/therapists',{year,expected:selected.expected,therapistIds:new FormData($('maCaseload')).getAll('therapist').map(Number)},'PUT');saved(out.pupil);}catch(e){status(e.message,'error');}
  }
  root.addEventListener('input',e=>{if(e.target.closest('form'))inputChanged();});
  root.addEventListener('change',e=>{if(e.target.closest('form')){inputChanged();syncKindNote();}});
  root.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.maOpen){launch(b.dataset.maOpen);return;}
    if(b.dataset.maId&&canDiscard()&&!busy){selected=rows().find(r=>String(idOf(r))===b.dataset.maId);dirty=false;renderList();renderDetail();}
    if(b.dataset.maTab&&canDiscard()&&!busy){tab=b.dataset.maTab;selected=null;dirty=false;root.querySelectorAll('[data-ma-tab]').forEach(n=>n.setAttribute('aria-pressed',String(n===b)));['maKindLabel','maClassLabel','maGradeLabel','maTherapistLabel'].forEach(id=>$(id).hidden=tab==='employees');['maProfessionLabel','maDutyLabel'].forEach(id=>$(id).hidden=tab!=='employees');$('maAdd').textContent=tab==='pupils'?'＋ Додај ученик':'＋ Додај вработен';renderList();renderDetail();}
    if(b.id==='maCancel'&&!busy&&canDiscard()){dirty=false;renderDetail();status('Внесот е откажан.');}
    if(b.id==='maHistory'){const id=selected.public_id;try{const out=await ctx.request('GET','/api/workspace/pupils/'+encodeURIComponent(id)+'/history');if(selected?.public_id!==id||!$('maHistoryResult'))return;$('maHistoryResult').innerHTML='<ul class="ma-history">'+out.history.map(h=>`<li>${esc(h.year)} · ${esc(h.grade||'Без паралелка')} · ${esc(h.oddelenie||'Непотврдено одделение')} · ${esc(programmes[h.programme])} · ${esc(placements[h.placement])}${h.active?'':' · неактивен'}</li>`).join('')+'</ul>';}catch(error){status(error.message,'error');}}
    if(b.id==='maEmployeeHistory'){const id=selected.id;try{const out=await ctx.request('GET','/api/workspace/employees/'+id+'/history');if(tab!=='employees'||selected?.id!==id||!$('maEmployeeHistoryResult'))return;$('maEmployeeHistoryResult').innerHTML=out.history.length?'<ul class="ma-history">'+out.history.map(h=>`<li>${esc(h.year)} · ${esc(data.staffProfessions[h.profession_code]||h.profession_code)} · ${esc(h.job_title||'Без работно место')} · ${esc(h.duties.map(k=>data.staffDuties[k]||k).join(', ')||'Непотврдени задолженија')}</li>`).join('')+'</ul>':'<p class="ma-hint">Сè уште нема внесени годишни задолженија.</p>';}catch(error){status(error.message,'error');}}
    if(b.id==='maLink'&&!busy){if(dirty){status('Прво зачувајте или откажете го внесот.','error');return;}const source=data.employees.find(r=>String(r.id)===$('maLinkSource').value);if(!source)return;if(!confirm(`Потврдувате дека „${source.name}“ (#${source.id}) и „${selected.name}“ (#${selected.id}) се истата личност? Профилите ќе се поврзат.`))return;try{const out=await write('/api/workspace/employees/'+selected.id+'/link',{year,sourceId:source.id,expected:selected.expected,sourceExpected:source.expected},'POST');data.employees=data.employees.filter(r=>r.id!==source.id);saved(out.employee);}catch(error){status(error.message,'error');}}
  });
  $('maSearch').addEventListener('input',renderList);['maActive','maKind','maClass','maGrade','maTherapist','maProfession','maDuty'].forEach(id=>$(id).addEventListener('change',renderList));
  $('maAdd').addEventListener('click',()=>{if(!data||readonly||busy||!canDiscard())return;selected=tab==='pupils'?{name:'',enrollment_type:'internal',boarding:false,programme:'unknown',placement:'unknown',annual_active:true,therapists:[]}:{name:'',identifier:'',additional_roles:[],teacher_kind:'none'};dirty=false;renderList();renderDetail();$('maForm').elements.name.focus();});
  $('maYear').addEventListener('change',()=>{if(canDiscard())load($('maYear').value);else $('maYear').value=year;});
  $('maReload').addEventListener('click',()=>{if(canDiscard())load(year);});$('maClose').addEventListener('click',close);
  toggle.addEventListener('click',()=>{root.hidden=false;toggle.setAttribute('aria-expanded','true');if(!data)load();else if(base!==ctx.server())status('Избран е друг сервер. Освежете пред уредување.','error');$('maSearch').focus();});
  document.querySelector('#appTabs').addEventListener('click',e=>{if(e.target.closest('[data-app]'))close();});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  window.addEventListener('mtb:server-state',e=>{if(e.detail?.mirror?.mode==='readonly'){readonly=true;applyReadonly();status('Локална копија · само читање');}});
  if(new URLSearchParams(location.search).get('view')!=='windows')toggle.click();
})();
