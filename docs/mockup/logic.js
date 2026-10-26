<script type="text/x-dc" data-dc-script="" data-props="{&quot;defaultTheme&quot;:{&quot;editor&quot;:&quot;enum&quot;,&quot;options&quot;:[&quot;dark&quot;,&quot;light&quot;],&quot;default&quot;:&quot;dark&quot;,&quot;tsType&quot;:&quot;'dark'|'light'&quot;,&quot;section&quot;:&quot;Appearance&quot;},&quot;density&quot;:{&quot;editor&quot;:&quot;enum&quot;,&quot;options&quot;:[&quot;compact&quot;,&quot;comfortable&quot;],&quot;default&quot;:&quot;comfortable&quot;,&quot;tsType&quot;:&quot;'compact'|'comfortable'&quot;,&quot;section&quot;:&quot;Appearance&quot;},&quot;aiPanelOpen&quot;:{&quot;editor&quot;:&quot;boolean&quot;,&quot;default&quot;:true,&quot;tsType&quot;:&quot;boolean&quot;,&quot;section&quot;:&quot;Layout&quot;},&quot;startScreen&quot;:{&quot;editor&quot;:&quot;enum&quot;,&quot;options&quot;:[&quot;launcher&quot;,&quot;first-run&quot;,&quot;workspace&quot;],&quot;default&quot;:&quot;launcher&quot;,&quot;tsType&quot;:&quot;string&quot;,&quot;section&quot;:&quot;Layout&quot;}}">
const IDC={slate:'#64748B',azure:'#3B82F6',teal:'#14B8A6',lime:'#84CC16',amber:'#F59E0B',coral:'#F43F5E',violet:'#8B5CF6',fuchsia:'#D946EF'};
const TYPEC={numeric:'#5B9DD9',text:'#8A99A4',temporal:'#A98BD6',boolean:'#4FB3A5',structured:'#D9A441',identifier:'#D97E8A',other:'#6E7F8A'};
const MONO="'IBM Plex Mono',monospace";
const COND="'IBM Plex Sans Condensed',sans-serif";
const COLS=[
 {key:'id',type:'int8',fam:'numeric',w:'82px',pk:true,num:true},
 {key:'email',type:'text',fam:'text',w:'210px'},
 {key:'plan',type:'text',fam:'text',w:'104px'},
 {key:'is_active',type:'bool',fam:'boolean',w:'92px'},
 {key:'mrr',type:'numeric',fam:'numeric',w:'96px',num:true},
 {key:'created_at',type:'timestamptz',fam:'temporal',w:'172px'},
 {key:'metadata',type:'jsonb',fam:'structured',w:'116px'},
 {key:'org_id',type:'uuid',fam:'identifier',w:'268px',fk:true}
];
const GRIDT='46px '+COLS.map(c=>c.w).join(' ');
const NAMES=['ana','ben','cy','dara','eli','fen','gus','hana','ivo','jun','kai','lena','mira','noor','omar','pia','quinn','rui','sena','tao'];
const PLANS=['free','pro','team','enterprise'];
function rnd(i,s){let x=(i*2654435761+s*40503)%100000;return x/100000}
function hex(i,n){let out='';for(let k=0;k<n;k++){out+='0123456789abcdef'[Math.floor(rnd(i,k+7)*16)]}return out}
function mkRows(){const out=[];for(let i=1;i<=120;i++){const r=rnd(i,1);const nm=NAMES[i%NAMES.length];
 out.push({id:i,email:nm+i+'@example.com',plan:PLANS[Math.floor(rnd(i,2)*4)],is_active:r>0.22,
  mrr:rnd(i,3)>0.86?null:Math.round(19+rnd(i,4)*880),
  created_at:'2024-'+(1+Math.floor(rnd(i,5)*9)<10?'0':'')+(1+Math.floor(rnd(i,5)*9))+'-'+(10+Math.floor(rnd(i,6)*18))+' '+(8+Math.floor(rnd(i,8)*11))+':'+(10+Math.floor(rnd(i,9)*49)),
  metadata:rnd(i,10)>0.8?null:{keys:2+Math.floor(rnd(i,11)*6)},
  org_id:hex(i,8)+'-'+hex(i,4)+'-4'+hex(i,3)+'-a'+hex(i,3)+'-'+hex(i,12)});}
 return out}
const ROWS=mkRows();
const SQL_DEFAULT="select u.id, u.email, count(o.id) as orders\nfrom users u\nleft join orders o on o.user_id = u.id\nwhere u.created_at > now() - interval '30 days'\ngroup by 1, 2\norder by orders desc;";
const SQL_BROKEN="select c.name, sum(oi.qty * oi.price) as revenue\nfrom customers c\njoin ordrs o on o.customer_id = c.id\njoin order_items oi on oi.order_id = o.id\ngroup by 1\norder by revenue desc\nlimit 10;";
const KNOWN=['users','orders','order_items','events','customers','sessions','invoices'];
const TREE={public:{tables:['users','orders','order_items','events','customers','invoices','sessions'],views:['active_users','mrr_by_month'],functions:['bill_cycle','tsv_update'],enums:['order_status','plan_tier']},analytics:{tables:['fct_orders','dim_users'],views:['cohorts']}};
const DDL=["create table public.users (","  id           bigserial primary key,","  email        text not null unique,","  plan         text not null default 'free',","  is_active    boolean not null default true,","  mrr          numeric(10,2),","  created_at   timestamptz not null default now(),","  metadata     jsonb,","  org_id       uuid references public.orgs (id) on delete set null",");","","create index users_created_at_idx on public.users using btree (created_at desc);","create index users_metadata_gin on public.users using gin (metadata);","","alter table public.users enable row level security;"];
const ERD=[
 {name:'users',x:60,y:60,w:212,est:'~48.2k',cols:[['id','int8','pk'],['email','text',''],['org_id','uuid','fk']]},
 {name:'orders',x:400,y:52,w:212,est:'~131k',cols:[['id','int8','pk'],['user_id','int8','fk'],['status','text','']]},
 {name:'order_items',x:400,y:270,w:212,est:'~402k',cols:[['id','int8','pk'],['order_id','int8','fk'],['qty','int4','']]},
 {name:'customers',x:60,y:300,w:212,est:'~12.9k',cols:[['id','int8','pk'],['name','text',''],['user_id','int8','fk']]},
 {name:'invoices',x:730,y:150,w:200,est:'~88.4k',cols:[['id','int8','pk'],['order_id','int8','fk']]}
];
const EDGES=[
 {d:'M272 104 H336 V96 H400',from:'users',to:'orders',inferred:false,lx:342,ly:90,lt:'1 — ∞'},
 {d:'M506 160 V270',from:'orders',to:'order_items',inferred:false,lx:512,ly:220,lt:'1 — ∞'},
 {d:'M612 110 H670 V194 H730',from:'orders',to:'invoices',inferred:false,lx:676,ly:150,lt:'1 — ∞'},
 {d:'M166 190 V300',from:'users',to:'customers',inferred:true,lx:174,ly:250,lt:'inferred'}
];
class Component extends DCLogic{
 state={
  theme:this.props.defaultTheme||'dark',density:this.props.density||'comfortable',
  route:this.props.startScreen==='workspace'?'workspace':'launcher',search:'',connecting:null,connId:this.props.startScreen==='workspace'?'c2':null,
  tabsSeeded:this.props.startScreen!=='workspace',
  sidebar:true,side:'objects',treeFilter:'',expanded:{public:true,'public.tables':true},
  tabs:[],active:null,sub:'Data',gridFilter:'',sort:null,loading:false,
  dirty:{},newRows:[],delRows:{},edit:null,editVal:'',review:false,inspector:null,
  aiOpen:this.props.aiPanelOpen!==false,aiCtx:'Schema only',msgs:[],aiInput:'',
  qs:{},resTab:'Results',
  roleSel:'app',roleFilter:'',grants:{},grantReview:false,attrOverride:{},
  auditQ:'',auditF:{},auditSel:null,
  memberRoles:{},access:{},sso:true,ssoOpts:[true,true,true,false],
  live:true,range:'6h',slowSort:'Total time',alerts:['a2','a1','a3'],
  migSel:'20260814_1140',migDir:'Up',
  jobFilter:'All',jobSel:'j1',jobPaused:{},jobOpts:[true,true,true,false],
  apprFilter:'Waiting on me',apprSel:'ap-118',apprState:{},apprNotes:{},apprNoteDraft:'',
  catQ:'',catFilter:'All',catSel:'users.email',catKlass:{},catMask:{},pitr:97,
  notifOpen:false,notifs:['n1','n2','n3','n4'],shortcuts:false,
  libQ:'',libFilter:'All',libSel:'q1',libParamVals:{},libShareOpts:[true,true,false],
  ips:[['10.2.0.0/16','office'],['10.4.1.0/24','ci'],['198.51.100.22/32','maya vpn']],newIp:'',secPol:[true,false,true,true,true],idle:'8h',
  integ:[true,true,true,true,false,true],evSub:{},
  dsrSel:'d1',dsrState:{},usageRange:'This month',adminOpen:true,
  dqFilter:'All',dqSel:'t3',dqMuted:{},dqRunning:false,dqOpts:[true,false,true],
  flagState:[true,true,true,true,false],upgraded:false,
  cfg:{model:'model-balanced',budget:40,ctx:'Schema only',samples:5,hardOff:false,
   redact:['password','token','secret','ssn','card','api_key'],newPat:'',
   feats:[true,true,true,true,false,true],keyState:null},
  palette:false,pq:'',switcher:false,modal:null,form:null,confirm:null,ctx:null,toast:null,
  apiKey:'sk-ant-••••••••••••7f2a',safety:[true,true,true,false],
  conns:[
   {id:'c1',name:'analytics_prod',color:'coral',env:'prod',host:'db.internal',port:5432,db:'analytics',user:'postgres',ro:true,up:true,opened:'opened 2 hours ago',recent:true},
   {id:'c2',name:'shop_staging',color:'amber',env:'staging',host:'stg.internal',port:5432,db:'shop',user:'app',ro:false,up:true,opened:'opened yesterday',recent:true},
   {id:'c3',name:'shop_local',color:'teal',env:'local',host:'localhost',port:5432,db:'shop',user:'dev',ro:false,up:true,opened:'opened 3 days ago'},
   {id:'c4',name:'events_dev',color:'azure',env:'dev',host:'10.0.0.4',port:5432,db:'events',user:'dev',ro:false,up:false,opened:'opened last week'}
  ]
 };
 componentDidMount(){document.documentElement.dataset.theme=this.state.theme;
  if(this.props.startScreen==='first-run')this.setState({conns:[]});
  if(this.props.startScreen==='workspace'&&!this.state.tabs.length)this.setState({
   tabs:[{id:'t1',kind:'table',title:'users',schema:'public'},{id:'t2',kind:'query',title:'untitled'},{id:'t3',kind:'erd',title:'public'}],active:'t1',sub:'Data',
   qs:{t2:{sql:SQL_DEFAULT,phase:'idle'}}});
  this._k=e=>{const m=e.metaKey||e.ctrlKey;const k=(e.key||'').toLowerCase();
   if(m&&k==='k'){e.preventDefault();this.setState({palette:true,pq:'',switcher:false})}
   else if(m&&k==='b'){e.preventDefault();this.setState(s=>({sidebar:!s.sidebar}))}
   else if(m&&k==='i'&&!e.shiftKey){e.preventDefault();this.setState(s=>({aiOpen:!s.aiOpen}))}
   else if(m&&k==='t'){e.preventDefault();this.newQueryTab()}
   else if(m&&k==='/'){e.preventDefault();this.setState(s=>({shortcuts:!s.shortcuts}))}
   else if(m&&k==='enter'){const t=this.tab();if(t&&t.kind==='query'){e.preventDefault();this.run()}}
   else if(k==='escape'){this.setState({palette:false,modal:null,confirm:null,ctx:null,review:false,edit:null,shortcuts:false,notifOpen:false})}};
  document.addEventListener('keydown',this._k);
  this._rz=()=>this.setState({winW:window.innerWidth});this._rz();
  window.addEventListener('resize',this._rz)}
 componentDidUpdate(){document.documentElement.dataset.theme=this.state.theme}
 componentWillUnmount(){document.removeEventListener('keydown',this._k);window.removeEventListener('resize',this._rz);clearTimeout(this._t)}
 rowH(){return this.state.density==='compact'?28:34}
 conn(){return this.state.conns.find(c=>c.id===this.state.connId)||this.state.conns[0]}
 tab(){return this.state.tabs.find(t=>t.id===this.state.active)}
 idc(c){return IDC[c.color]||IDC.slate}
 envStyle(env){const prod=env==='prod';return{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',padding:'1px 5px',whiteSpace:'nowrap',flex:'none',background:prod?'var(--danger)':'transparent',color:prod?'#10151A':'var(--text-secondary)',border:prod?'none':'1px solid var(--border-strong)'}}
 seg(list,cur,fn,extra){return list.map(l=>({label:l,onClick:()=>fn(l),style:Object.assign({padding:'0 9px',fontSize:12,fontFamily:COND,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',background:l===cur?'var(--bg-selected)':'transparent',color:l===cur?'var(--text-primary)':'var(--text-muted)',borderRight:'1px solid var(--border-subtle)'},extra||{})}))}
 toast(text,sub,kind){clearTimeout(this._tt);this.setState({toast:{text,sub,kind:kind||'success'}});this._tt=setTimeout(()=>this.setState({toast:null}),4200)}
 open(c){this.setState({connecting:c.id});clearTimeout(this._t);this._t=setTimeout(()=>{
  this.setState({connecting:null,route:'workspace',connId:c.id,
   tabs:[{id:'t1',kind:'table',title:'users',schema:'public'},{id:'t2',kind:'query',title:'untitled'},{id:'t3',kind:'erd',title:'public'}],active:'t1',sub:'Data',
   qs:{t2:{sql:SQL_DEFAULT,phase:'idle'}}})},620)}
 newQueryTab(){const id='q'+Date.now();this.setState(s=>({tabs:s.tabs.concat([{id,kind:'query',title:'untitled'}]),active:id,qs:Object.assign({},s.qs,{[id]:{sql:SQL_BROKEN,phase:'idle'}})}))}
 openTable(name){this.setState(s=>{const ex=s.tabs.find(t=>t.kind==='table'&&t.title===name);
  if(ex)return{active:ex.id,sub:'Data'};const id='tb'+Date.now();
  return{tabs:s.tabs.concat([{id,kind:'table',title:name,schema:'public'}]),active:id,sub:'Data'}})}
 openSettings=()=>{this.setState(s=>{const ex=s.tabs.find(t=>t.kind==='settings');if(ex)return{active:ex.id};const id='st';return{tabs:s.tabs.concat([{id,kind:'settings',title:'Settings'}]),active:id}})}
 openKind(kind,title){this.setState(s=>{const ex=s.tabs.find(t=>t.kind===kind);if(ex)return{active:ex.id};const id=kind;return{tabs:s.tabs.concat([{id,kind,title}]),active:id}})}
 qs(){const t=this.tab();return(t&&this.state.qs[t.id])||{sql:SQL_DEFAULT,phase:'idle'}}
 setQs(patch){const t=this.tab();if(!t)return;this.setState(s=>({qs:Object.assign({},s.qs,{[t.id]:Object.assign({},s.qs[t.id],patch)})}))}
 run=()=>{const q=this.qs();const m=/(?:from|join)\s+([a-z_][\w]*)/gi;let bad=null,x;
  while((x=m.exec(q.sql))){if(KNOWN.indexOf(x[1].toLowerCase())<0){bad=x[1];break}}
  this.setQs({phase:'running',started:Date.now()});clearTimeout(this._q);
  this._q=setTimeout(()=>{if(bad){this.setQs({phase:'error',err:{msg:'ERROR:  relation "'+bad+'" does not exist',code:'42P01',pos:78,line:3,tok:bad},ms:38})}
   else{this.setQs({phase:'done',ms:240,rows:ROWS.slice(0,60).map(r=>({id:r.id,email:r.email,orders:Math.round(rnd(r.id,21)*40)}))})}},900)}
 cancel=()=>{clearTimeout(this._q);this.setQs({phase:'error',err:{msg:'ERROR:  canceling statement due to user request',code:'57014',pos:1,line:1,tok:''},ms:412})}
 setDirty(rid,key,val){this.setState(s=>({dirty:Object.assign({},s.dirty,{[rid+':'+key]:val}),edit:null}))}
 pending(){const d=this.state.dirty;const by={};Object.keys(d).forEach(k=>{const p=k.split(':');by[p[0]]=by[p[0]]||{};by[p[0]][p[1]]=d[k]});
  const lit=v=>{if(v===null||v===undefined||v==='')return 'null';if(/^-?\d+(\.\d+)?$/.test(String(v)))return String(v);if(/^(true|false)$/i.test(String(v)))return String(v).toLowerCase();return "'"+String(v).replace(/'/g,"''")+"'"};
  const out=Object.keys(by).map(rid=>({kind:'UPDATE',rid,sql:'update public.users set '+Object.keys(by[rid]).map(c=>c+' = '+lit(by[rid][c])).join(', ')+'\nwhere id = '+rid+';'}));
  Object.keys(this.state.delRows).forEach(rid=>out.push({kind:'DELETE',rid,sql:'delete from public.users where id = '+rid+';'}));
  this.state.newRows.forEach(r=>out.push({kind:'INSERT',rid:'new'+r,sql:"insert into public.users (email, plan, is_active)\nvalues ('', 'free', true);"}));
  return out}
 askAI=(text)=>{const kind=/fix|error|does not exist/i.test(text)?'fix':(/explain/i.test(text)?'explain':'sql');
  this.setState(s=>({msgs:s.msgs.concat([{who:'You',user:true,text},{who:'AI',streaming:true}]),aiInput:''}));
  clearTimeout(this._a);this._a=setTimeout(()=>{
   const rep=kind==='fix'?{sql:"select c.name, sum(oi.qty * oi.price) as revenue\nfrom customers c\njoin orders o on o.customer_id = c.id\njoin order_items oi on oi.order_id = o.id\ngroup by 1\norder by revenue desc\nlimit 10;",prose:'The relation was misspelled — the table is orders, not ordrs. Everything else type-checks against the catalog.'}
    :kind==='explain'?{prose:'It counts orders per user for accounts created in the last 30 days. The left join keeps users with zero orders; the group by on ordinals 1, 2 groups by id and email, so the count is per user.'}
    :{sql:"select c.name,\n       sum(oi.qty * oi.price) as revenue\nfrom customers c\njoin orders o on o.customer_id = c.id\njoin order_items oi on oi.order_id = o.id\nwhere o.created_at >= date_trunc('quarter', now()) - interval '3 months'\n  and o.created_at <  date_trunc('quarter', now())\ngroup by 1\norder by revenue desc\nlimit 10;",prose:'Joins orders → order_items for line totals; quarter comes from orders.created_at. I assumed revenue excludes refunds — orders.status has a refunded value, say the word and I will filter it out.'};
   this.setState(s=>{const m=s.msgs.slice();m[m.length-1]=Object.assign({who:'AI'},rep);return{msgs:m}})},900)}
 renderVals(){
  const S=this.state,C=this.conn(),rh=this.rowH(),t=this.tab(),q=this.qs();
  const cellBase={display:'flex',alignItems:'center',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',position:'relative',cursor:'default',overflow:'hidden',whiteSpace:'nowrap'};
  const monoV={fontFamily:MONO,fontSize:13,fontVariantNumeric:'tabular-nums',overflow:'hidden',textOverflow:'ellipsis'};
  const vals={};
  vals.isLauncher=S.route==='launcher';vals.isWorkspace=S.route==='workspace';
  vals.toggleTheme=()=>this.setState(s=>({theme:s.theme==='dark'?'light':'dark'}));
  vals.stop=e=>e.stopPropagation();
  vals.search=S.search;vals.onSearch=e=>this.setState({search:e.target.value});
  const q1=S.search.toLowerCase();
  const match=c=>!q1||(c.name+c.host+c.env+c.db).toLowerCase().indexOf(q1)>=0;
  const card=c=>({name:c.name,env:c.env.toUpperCase(),readOnly:c.ro,dsn:c.host+':'+c.port+' · '+c.user,opened:c.opened,
   connecting:S.connecting===c.id,dot:c.up?'●':'○',
   dotStyle:{fontSize:10,color:c.up?'var(--state-success)':'var(--text-muted)'},
   envStyle:this.envStyle(c.env),
   cardStyle:{display:'flex',alignItems:'stretch',background:'var(--bg-raised)',border:'1px solid var(--border-subtle)',borderRadius:6,cursor:'pointer',overflow:'hidden'},
   barStyle:{width:3,flex:'none',background:this.idc(c)},
   onOpen:()=>this.open(c),onEdit:e=>{e.stopPropagation();this.setState({modal:'edit',form:{name:c.name,host:c.host,port:String(c.port),db:c.db,user:c.user,pass:'••••••••',dsn:'',color:c.color,env:c.env,ro:c.ro},test:null})}});
  const rec=S.conns.filter(c=>c.recent&&match(c)),all=S.conns.filter(match);
  vals.connGroups=[{label:'Recent',items:rec.map(card)},{label:'All connections',items:all.map(card)}].filter(g=>g.items.length);
  vals.noConnMatches=all.length===0;
  vals.firstRun=S.conns.length===0;
  vals.loadDemo=()=>{this.setState({conns:[{id:'demo',name:'comb_demo',color:'teal',env:'local',host:'localhost',port:5432,db:'comb_demo',user:'demo',ro:false,up:true,opened:'just now',recent:true}]});
   this.toast('Demo database ready','42 tables, 1.2M rows of plausible e-commerce data. Everything on it is safe to break.','success')};
  vals.onboardSteps=[['01','Paste a connection string','Comb parses it into host, port, database and user, and never echoes the password back.'],['02','Tag the environment','A prod tag turns on read-only and typed confirmations before anything destructive.'],['03','Open a table','The grid, the structure and the DDL are one keystroke apart. Nothing is behind a wizard.']].map(s=>({n:s[0],title:s[1],body:s[2]}));
  vals.newConn=()=>this.setState({modal:'new',form:{name:'',host:'',port:'5432',db:'',user:'',pass:'',dsn:'',color:'slate',env:'local',ro:false},test:null});
  // chrome
  vals.conn={name:C.name,env:C.env.toUpperCase(),readOnly:C.ro,envStyle:this.envStyle(C.env)};
  vals.chromeStyle={height:40,flex:'none',display:'grid',gridTemplateColumns:'1fr auto 1fr',alignItems:'center',gap:12,padding:'0 10px',position:'relative',background:'color-mix(in oklab, '+this.idc(C)+' 9%, var(--bg-raised))',borderBottom:'1px solid var(--border-subtle)'};
  vals.chromeEdgeStyle={position:'absolute',left:0,right:0,top:0,height:3,background:this.idc(C)};
  vals.chromeBarStyle={width:3,height:18,background:this.idc(C),flex:'none'};
  vals.aiBtnStyle={height:24,padding:'0 10px',borderRadius:3,fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',border:'1px solid '+(S.aiOpen?'transparent':'var(--border-strong)'),background:S.aiOpen?'var(--btn-primary)':'transparent',color:S.aiOpen?'var(--text-inverse)':'var(--text-secondary)'};
  vals.openPalette=()=>this.setState({palette:true,pq:'',switcher:false});
  vals.openSwitcher=()=>this.setState({palette:true,pq:'',switcher:true});
  vals.openSettings=this.openSettings;
  vals.toggleAI=()=>this.setState(s=>({aiOpen:!s.aiOpen}));
  vals.sidebarOpen=S.sidebar;vals.toggleSidebar=()=>this.setState({sidebar:false});
  vals.sideSections=['Objects','Queries','History'].map(l=>({label:l,onClick:()=>this.setState({side:l.toLowerCase(),treeFilter:''}),
   style:{flex:1,fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:S.side===l.toLowerCase()?'var(--text-primary)':'var(--text-muted)',borderBottom:'2px solid '+(S.side===l.toLowerCase()?this.idc(C):'transparent')}}));
  vals.treeFilter=S.treeFilter;vals.onTreeFilter=e=>this.setState({treeFilter:e.target.value});
  vals.sidePlaceholder=S.side==='objects'?'filter objects':S.side==='queries'?'filter saved queries':'search history';
  const kindIs=t?t.kind:'none';
  const f2=S.treeFilter.toLowerCase();const rows=[];
  const rowStyle=(depth,active)=>({display:'flex',alignItems:'center',gap:6,height:24,padding:'0 8px 0 '+(8+depth*13)+'px',cursor:'pointer',background:active?'var(--bg-selected)':'transparent'});
  if(S.side==='objects'){
   Object.keys(TREE).forEach(sch=>{
    const opens=S.expanded[sch];
    rows.push({label:sch,icon:opens?'▾':'▸',meta:'',style:rowStyle(0,false),iconStyle:{color:'var(--text-muted)',fontSize:9,width:9},labelStyle:{fontFamily:MONO,fontSize:12,fontWeight:500},onClick:()=>this.setState(s=>({expanded:Object.assign({},s.expanded,{[sch]:!s.expanded[sch]})})),onCtx:e=>e.preventDefault()});
    if(!opens)return;
    Object.keys(TREE[sch]).forEach(grp=>{
     const gk=sch+'.'+grp,go=S.expanded[gk],items=TREE[sch][grp].filter(n=>!f2||n.indexOf(f2)>=0);
     if(f2&&!items.length)return;
     rows.push({label:grp.charAt(0).toUpperCase()+grp.slice(1),icon:go||f2?'▾':'▸',meta:String(TREE[sch][grp].length),style:rowStyle(1,false),iconStyle:{color:'var(--text-muted)',fontSize:9,width:9},labelStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-secondary)'},onClick:()=>this.setState(s=>({expanded:Object.assign({},s.expanded,{[gk]:!s.expanded[gk]})})),onCtx:e=>e.preventDefault()});
     if(!go&&!f2)return;
     items.forEach(n=>{
      const ic=grp==='tables'?'▤':grp==='views'?'◫':grp==='functions'?'ƒ':'☰';
      rows.push({label:n,icon:ic,meta:'',style:rowStyle(2,t&&t.kind==='table'&&t.title===n),iconStyle:{color:'var(--text-muted)',fontSize:11,width:11,fontFamily:grp==='functions'?MONO:'inherit'},labelStyle:{fontFamily:MONO,fontSize:12,overflow:'hidden',textOverflow:'ellipsis'},
       onClick:()=>{if(grp==='tables'||grp==='views')this.openTable(n)},
       onCtx:e=>{e.preventDefault();this.setState({ctx:{x:e.clientX,y:e.clientY,table:n}})}});});});});
  }else if(S.side==='queries'){
   [['MRR by month','q1'],['Churn cohort','q2'],['Stuck orders','q3'],['Schema sizes','q4'],['Duplicate emails','q5'],['Refund rate by region','q6'],['Index candidates','q7'],['PII inventory','q8']].filter(x=>!f2||x[0].toLowerCase().indexOf(f2)>=0).forEach(x=>
    rows.push({label:x[0],icon:'⌗',meta:'',style:rowStyle(0,false),iconStyle:{color:'var(--text-muted)',fontSize:11,width:11},labelStyle:{fontFamily:MONO,fontSize:12},onClick:()=>{this.setState({libSel:x[1]});this.openKind('library','Library')},onCtx:e=>e.preventDefault()}));
   rows.push({label:'Open the full library',icon:'❂',meta:'',style:Object.assign(rowStyle(0,false),{marginTop:4,borderTop:'1px solid var(--border-subtle)'}),iconStyle:{color:'var(--text-muted)',fontSize:11,width:11},labelStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-secondary)'},onClick:()=>this.openKind('library','Library'),onCtx:e=>e.preventDefault()});
  }else{
   [['select * from users limit 100','240 ms','ok'],['update orders set status = …','1.2 s','ok'],['select * from ordrs','38 ms','err'],['vacuum analyze users','8.4 s','ok']].filter(x=>!f2||x[0].indexOf(f2)>=0).forEach(x=>
    rows.push({label:x[0],icon:x[2]==='ok'?'✓':'✕',meta:x[1],style:rowStyle(0,false),iconStyle:{color:x[2]==='ok'?'var(--state-success)':'var(--state-error)',fontSize:10,width:11},labelStyle:{fontFamily:MONO,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',color:'var(--text-secondary)'},onClick:()=>this.newQueryTab(),onCtx:e=>e.preventDefault()}));
  }
  if(S.side==='objects'&&!f2){
   rows.push({label:'Admin',icon:S.adminOpen?'▾':'▸',meta:'18',
    style:Object.assign(rowStyle(0,false),{marginTop:6,borderTop:'1px solid var(--border-subtle)',paddingTop:2}),
    iconStyle:{color:'var(--text-muted)',fontSize:9,width:9},
    labelStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-secondary)'},
    onClick:()=>this.setState(s=>({adminOpen:!s.adminOpen})),onCtx:e=>e.preventDefault()});
   if(S.adminOpen)[['Monitoring','◷','monitor','Monitoring','3'],['Approvals','✓','approvals','Approvals','3'],['Cluster topology','⌬','topology','Topology',''],['Migrations','⇅','migrations','Migrations','1'],['Scheduled jobs','◴','jobs','Jobs','6'],['Query library','❂','library','Library','8'],['Data catalog','◈','catalog','Data catalog','6'],['Data quality','◎','quality','Data quality','2'],['Backups','⛁','backup','Backups',''],['Audit trail','☰','audit','Audit trail',''],['Compliance','§','compliance','Compliance','2'],['Usage & cost','≡','usage','Usage',''],['Roles & privileges','⚿','roles','Roles','6'],['Team & access','◍','team','Team & access','6'],['Security','⛨','security','Security',''],['Integrations','⇄','integrations','Integrations','5'],['Deployment','⌗','deploy','Deployment','1'],['AI configuration','✳','ai','AI configuration','']].forEach(a=>{
    rows.push({label:a[0],icon:a[1],meta:a[4],style:rowStyle(1,kindIs===a[2]),
     iconStyle:{color:'var(--text-muted)',fontSize:11,width:11},
     labelStyle:{fontFamily:MONO,fontSize:12,color:kindIs===a[2]?'var(--text-primary)':'var(--text-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},
     onClick:()=>this.openKind(a[2],a[3]),onCtx:e=>e.preventDefault()});});}
  vals.sideRows=rows;vals.sideEmpty=rows.length===0;
  // tabs
  vals.tabs=S.tabs.map(x=>({title:x.title,dirty:x.kind==='table'&&Object.keys(S.dirty).length>0,
   icon:({table:'▤',query:'⌗',erd:'⬡',roles:'⚿',ai:'✳',audit:'☰',team:'◍',monitor:'◷',migrations:'⇅',jobs:'◴',approvals:'✓',catalog:'◈',backup:'⛁',library:'❂',security:'⛨',integrations:'⇄',compliance:'§',usage:'≡',topology:'⌬',quality:'◎',deploy:'⌗'})[x.kind]||'⚙',
   iconStyle:{color:'var(--text-muted)',fontSize:11},
   titleStyle:{fontFamily:['settings','ai','team','monitor','audit','jobs','approvals','catalog','backup','library','security','integrations','compliance','usage','topology','quality','deploy'].indexOf(x.kind)>=0?'inherit':MONO,fontSize:12,maxWidth:130,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},
   style:{display:'flex',alignItems:'center',gap:7,padding:'0 9px',borderRight:'1px solid var(--border-subtle)',cursor:'pointer',background:x.id===S.active?'var(--bg-base)':'transparent',borderTop:'2px solid '+(x.id===S.active?this.idc(C):'transparent'),color:x.id===S.active?'var(--text-primary)':'var(--text-secondary)'},
   onClick:()=>this.setState({active:x.id}),
   onClose:e=>{e.stopPropagation();this.setState(s=>{const tabs=s.tabs.filter(y=>y.id!==x.id);return{tabs,active:s.active===x.id?(tabs[0]||{}).id:s.active}})}}));
  vals.newQueryTab=()=>this.newQueryTab();
  const kind=t?t.kind:'none';
  vals.isTableTab=kind==='table';vals.isQueryTab=kind==='query';vals.isErdTab=kind==='erd';vals.isSettingsTab=kind==='settings';
  vals.subTabs=['Data','Structure','Constraints','Indexes','Triggers','DDL'].map(l=>({label:l,onClick:()=>this.setState({sub:l}),
   style:{padding:'0 11px',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:S.sub===l?'var(--text-primary)':'var(--text-muted)',borderBottom:'2px solid '+(S.sub===l?'var(--text-primary)':'transparent')}}));
  vals.isData=S.sub==='Data';vals.isStructure=S.sub==='Structure';vals.isDDL=S.sub==='DDL';
  vals.isOtherSub=['Constraints','Indexes','Triggers'].indexOf(S.sub)>=0;vals.subTitle=S.sub;
  // grid
  vals.headStyle={display:'grid',gridTemplateColumns:GRIDT,position:'sticky',top:0,zIndex:2,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)'};
  vals.cols=COLS.map(c=>({key:c.key,type:c.type,mark:c.pk?'🔑':(c.fk?'🔗':''),
   markStyle:{fontSize:9,opacity:c.pk||c.fk?1:0},
   sortMark:S.sort===c.key?'↓':'',
   onSort:()=>this.setState(s=>({sort:s.sort===c.key?null:c.key})),
   tickStyle:{position:'absolute',left:0,top:0,bottom:0,width:2,background:TYPEC[c.fam]},
   headStyle:{position:'relative',display:'flex',borderRight:'1px solid var(--border-subtle)',cursor:'pointer',minWidth:0}}));
  const gf=S.gridFilter.toLowerCase();
  let data=ROWS.slice(0,60).filter(r=>!gf||(r.email+r.plan+r.id).toLowerCase().indexOf(gf)>=0);
  if(S.sort==='id')data=data.slice().reverse();
  vals.rows=data.map((r,i)=>{
   const del=!!S.delRows[r.id];
   return{n:i+1,
    rowStyle:{display:'grid',gridTemplateColumns:GRIDT,height:rh,borderBottom:'1px solid var(--border-subtle)',background:del?'color-mix(in oklab, var(--danger) 10%, transparent)':'transparent'},
    gutterStyle:{display:'flex',alignItems:'center',justifyContent:'flex-end',paddingRight:8,fontFamily:MONO,fontSize:11,color:'var(--text-muted)',background:'var(--bg-inset)',borderRight:'1px solid var(--border-subtle)',fontVariantNumeric:'tabular-nums'},
    cells:COLS.map(c=>{
     const dk=r.id+':'+c.key,dv=S.dirty[dk],has=dv!==undefined;
     let v=has?dv:r[c.key],display,color='var(--text-primary)';
     if(v===null||v===undefined){display='␀';color='var(--state-null)'}
     else if(c.key==='metadata'){display='{'+v.keys+' keys}';color=TYPEC.structured}
     else if(c.type==='bool'){display=String(v);color='var(--text-secondary)'}
     else display=String(v);
     if(c.key==='metadata'&&v)color=TYPEC.structured;
     const editing=S.edit&&S.edit.rid===r.id&&S.edit.key===c.key;
     return{display,editing:!!editing,showValue:!editing,dirty:has,
      valueStyle:Object.assign({},monoV,{color,textDecoration:del?'line-through':'none',opacity:del?.6:1,fontWeight:c.pk?500:400}),
      style:Object.assign({},cellBase,{justifyContent:c.num?'flex-end':'flex-start',background:has?'color-mix(in oklab, var(--state-running) 14%, transparent)':'transparent'}),
      onClick:()=>{if(c.key==='metadata'&&v)this.setState({inspector:{row:r.id,col:'metadata',type:'jsonb',size:(120+r.id)+' bytes',body:JSON.stringify({plan_source:'stripe',seats:v.keys,flags:['beta','invoice_v2'],last_login:'2024-05-1'+(r.id%9)+'T08:2'+(r.id%9)+':00Z'},null,2)}})},
      onEdit:()=>{if(C.ro){this.toast('Read-only connection','This session runs with default_transaction_read_only = on.','error');return}
       this.setState({edit:{rid:r.id,key:c.key},editVal:v===null?'':String(v)})}}})}});
  vals.editValue=S.editVal;
  vals.onEditChange=e=>this.setState({editVal:e.target.value});
  vals.commitEdit=()=>{if(S.edit)this.setDirty(S.edit.rid,S.edit.key,S.editVal)};
  vals.onEditKey=e=>{if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();vals.commitEdit()}else if(e.key==='Escape')this.setState({edit:null})};
  vals.gridLoading=S.loading;
  vals.skeletons=S.loading?[1,2,3,4,5,6,7,8,9,10,11,12].map(i=>({rowStyle:{display:'grid',gridTemplateColumns:GRIDT,height:rh,borderBottom:'1px solid var(--border-subtle)'},barStyle:{height:8,width:(40+((i*37)%50))+'%',background:'var(--bg-hover)',borderRadius:2}})):[];
  vals.gridEmpty=!S.loading&&data.length===0;
  vals.gridFilter=S.gridFilter;vals.onGridFilter=e=>this.setState({gridFilter:e.target.value});
  vals.clearFilter=()=>this.setState({gridFilter:''});
  vals.reload=()=>{this.setState({loading:true});clearTimeout(this._r);this._r=setTimeout(()=>this.setState({loading:false}),900)};
  vals.writeBtnStyle={height:22,padding:'0 8px',borderRadius:3,fontSize:12,whiteSpace:'nowrap',flex:'none',border:'1px solid var(--border-subtle)',color:C.ro?'var(--text-muted)':'var(--text-secondary)',opacity:C.ro?.5:1};
  vals.addRow=()=>{if(C.ro)return this.toast('Read-only connection','Writes are rejected server-side.','error');this.setState(s=>({newRows:s.newRows.concat([Date.now()])}))};
  vals.delRow=()=>{if(C.ro)return this.toast('Read-only connection','Writes are rejected server-side.','error');const first=data[0];if(first)this.setState(s=>({delRows:Object.assign({},s.delRows,{[first.id]:true})}))};
  vals.explainReadOnly=()=>this.toast('Read-only by design','analytics_prod opens with default_transaction_read_only = on. Turn it off in the connection editor.','info');
  const pend=this.pending();
  vals.hasPending=pend.length>0;vals.pendingCount=pend.length;
  vals.openReview=()=>this.setState({review:true});
  vals.discardAll=()=>this.setState({dirty:{},delRows:{},newRows:[]});
  vals.reviewOpen=S.review;vals.closeReview=()=>this.setState({review:false});
  vals.pendingStmts=pend.map(p=>({kind:p.kind,sql:p.sql,
   kindStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:p.kind==='DELETE'?'var(--danger)':p.kind==='INSERT'?'var(--state-success)':'var(--state-running)',width:56,flex:'none',paddingTop:2},
   onDiscard:()=>this.setState(s=>{if(p.kind==='DELETE'){const d=Object.assign({},s.delRows);delete d[p.rid];return{delRows:d}}
    if(p.kind==='INSERT')return{newRows:s.newRows.filter(x=>'new'+x!==p.rid)};
    const dd=Object.assign({},s.dirty);Object.keys(dd).forEach(k=>{if(k.split(':')[0]===p.rid)delete dd[k]});return{dirty:dd}})}));
  vals.applyChanges=()=>{const n=pend.length;this.setState({dirty:{},delRows:{},newRows:[],review:false});this.toast('Applied '+n+(n===1?' statement':' statements')+' in one transaction','COMMIT · 42 ms · 3 rows affected','success')};
  vals.pageLabel=(data.length?'1–'+data.length:'0')+' of ~48,201';
  vals.inspectorOpen=!!S.inspector;
  vals.inspector=S.inspector||{col:'',type:'',row:'',size:'',body:''};
  if(S.inspector)vals.inspector=Object.assign({},S.inspector,{badgeStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:TYPEC.structured,border:'1px solid '+TYPEC.structured,padding:'0 4px'}});
  vals.toggleInspector=()=>this.setState(s=>({inspector:s.inspector?null:{row:1,col:'metadata',type:'jsonb',size:'126 bytes',body:JSON.stringify({plan_source:'stripe',seats:4,flags:['beta'],last_login:'2024-05-11T08:20:00Z'},null,2)}}));
  vals.closeInspector=()=>this.setState({inspector:null});
  // structure
  vals.rlsOn=true;
  vals.structHeadStyle={display:'grid',gridTemplateColumns:'1.2fr 1fr .7fr 1fr 1.4fr',background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.structRows=COLS.map((c,i)=>({name:c.key,type:c.type,nullable:c.pk?'not null':(i%3===0?'not null':'null'),def:c.key==='created_at'?'now()':c.key==='plan'?"'free'":c.pk?'nextval(…)':'—',comment:c.key==='mrr'?'monthly recurring revenue, USD':'',mark:c.pk?'🔑':(c.fk?'🔗':''),markStyle:{fontSize:9,opacity:c.pk||c.fk?1:0},
   tickStyle:{width:2,height:14,background:TYPEC[c.fam],display:'inline-block'},
   style:{display:'grid',gridTemplateColumns:'1.2fr 1fr .7fr 1fr 1.4fr',borderTop:i?'1px solid var(--border-subtle)':'none'}}));
  vals.constraintRows=[{kind:'primary key',name:'users_pkey',def:'(id)'},{kind:'unique',name:'users_email_key',def:'(email)'},{kind:'foreign key',name:'users_org_id_fkey',def:'(org_id) → orgs(id) on delete set null'},{kind:'index',name:'users_created_at_idx',def:'btree (created_at desc)'},{kind:'policy',name:'users_tenant_isolation',def:'for all using (org_id = current_setting(…))'}];
  vals.ddlLines=DDL.map((l,i)=>({n:i+1,text:l,style:{fontFamily:MONO,fontSize:13,lineHeight:'20px',color:/^(create|alter)/.test(l)?'var(--text-primary)':'var(--text-secondary)',whiteSpace:'pre'}}));
  // query tab
  vals.sql=q.sql;vals.onSqlChange=e=>this.setQs({sql:e.target.value});
  vals.sqlLines=q.sql.split('\n').map((l,i)=>({n:i+1,gutterStyle:{fontFamily:MONO,fontSize:13,lineHeight:'20px',color:'var(--text-muted)',width:42,textAlign:'right',paddingRight:10,background:q.phase==='error'&&q.err&&q.err.line===i+1?'color-mix(in oklab, var(--state-error) 18%, transparent)':'transparent'}}));
  vals.running=q.phase==='running';vals.notRunning=q.phase!=='running';
  vals.runQuery=this.run;vals.cancelQuery=this.cancel;
  vals.hasErrorMark=q.phase==='error';
  vals.errorMarkStyle={position:'absolute',left:56,top:(q.err?(q.err.line-1)*20+27:0),width:60,height:2,background:'var(--state-error)',pointerEvents:'none'};
  const msgCount=q.phase==='done'?2:0;
  vals.resultTabs=['Results','Messages','Plan'].map(l=>({label:l,badge:l==='Messages'&&msgCount>0,badgeText:String(msgCount),onClick:()=>this.setState({resTab:l}),
   style:{padding:'0 11px',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:S.resTab===l?'var(--text-primary)':'var(--text-muted)',borderBottom:'2px solid '+(S.resTab===l?'var(--text-primary)':'transparent')}}));
  vals.resultMeta=q.phase==='running'?'running… '+((Date.now()-(q.started||Date.now()))/1000).toFixed(1)+'s':q.phase==='error'?'✕ failed · '+q.ms+' ms':q.phase==='done'?'✓ '+q.rows.length+' rows · '+q.ms+' ms · 12 KB':'idle';
  vals.resultMetaStyle={fontFamily:MONO,fontSize:12,whiteSpace:'nowrap',color:q.phase==='error'?'var(--state-error)':q.phase==='running'?'var(--state-running)':q.phase==='done'?'var(--state-success)':'var(--text-muted)'};
  vals.qError=q.phase==='error'&&S.resTab==='Results';
  vals.qErrMsg=q.err?q.err.msg:'';vals.qErrCode=q.err?q.err.code:'';vals.qErrPos=q.err?q.err.pos:'';vals.qErrLine=q.err?q.err.line:'';
  vals.fixWithAI=()=>{this.setState({aiOpen:true});this.askAI('Fix this error: '+(q.err?q.err.msg:''))};
  vals.qMessages=S.resTab==='Messages';
  vals.noticeLines=[{tag:'NOTICE',text:'identifier "orders_user_id_idx" will be truncated',tagStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:'var(--state-info)',width:64}},{tag:'INFO',text:'planning time 0.412 ms · execution time 239.6 ms',tagStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:'var(--text-muted)',width:64}}];
  vals.qIdle=q.phase==='idle'&&S.resTab==='Results';
  vals.qHasRows=q.phase==='done'&&S.resTab==='Results';
  const QC=[{key:'id',type:'int8',fam:'numeric',num:true,w:'90px'},{key:'email',type:'text',fam:'text',w:'240px'},{key:'orders',type:'int8',fam:'numeric',num:true,w:'110px'}];
  const QT='46px '+QC.map(c=>c.w).join(' ')+' 1fr';
  vals.qHeadStyle={display:'grid',gridTemplateColumns:QT,position:'sticky',top:0,zIndex:2,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)'};
  vals.qCols=QC.map(c=>({key:c.key,type:c.type,tickStyle:{position:'absolute',left:0,top:0,bottom:0,width:2,background:TYPEC[c.fam]},headStyle:{position:'relative',display:'flex',borderRight:'1px solid var(--border-subtle)'}}));
  vals.qRows=(q.rows||[]).map((r,i)=>({n:i+1,
   rowStyle:{display:'grid',gridTemplateColumns:QT,height:rh,borderBottom:'1px solid var(--border-subtle)'},
   gutterStyle:{display:'flex',alignItems:'center',justifyContent:'flex-end',paddingRight:8,fontFamily:MONO,fontSize:11,color:'var(--text-muted)',background:'var(--bg-inset)',borderRight:'1px solid var(--border-subtle)'},
   cells:QC.map(c=>({display:String(r[c.key]),valueStyle:Object.assign({},monoV,{color:'var(--text-primary)'}),style:Object.assign({},cellBase,{justifyContent:c.num?'flex-end':'flex-start'})}))}));
  // erd
  vals.detailSegs=this.seg(['Name','Keys','All'],S.erdDetail||'Keys',l=>this.setState({erdDetail:l}));
  vals.focusLabel=S.erdFocus||'—';
  vals.relayout=()=>this.toast('Layout recomputed','elkjs layered · 5 nodes · 14 ms in a worker','info');
  const det=S.erdDetail||'Keys';
  vals.erdNodes=ERD.map(n=>({name:n.name,est:n.est,
   cols:(det==='Name'?[]:n.cols.filter(c=>det==='All'||c[2])).map(c=>({name:c[0],type:c[1],mark:c[2]==='pk'?'🔑':c[2]==='fk'?'🔗':'',markStyle:{fontSize:9,width:10,opacity:c[2]?1:0}})),
   style:{position:'absolute',left:n.x,top:n.y,width:n.w,background:'var(--bg-raised)',border:'1px solid var(--border-strong)',borderRadius:3,boxShadow:'var(--shadow)',cursor:'pointer',overflow:'hidden'},
   headStyle:{display:'flex',alignItems:'center',gap:6,padding:'5px 8px',background:'var(--bg-overlay)',borderBottom:'1px solid var(--border-strong)'},
   onClick:()=>this.openTable(n.name)}));
  vals.edges=EDGES.map(e=>({d:e.d,stroke:e.inferred?'var(--text-muted)':'var(--border-strong)',width:e.inferred?1:1.5,dash:e.inferred?'4 4':'0'}));
  vals.edgeLabels=EDGES.map(e=>({x:e.lx,y:e.ly,text:e.lt,fill:e.inferred?'var(--text-muted)':'var(--text-secondary)'}));
  // settings
  vals.themeSegs=this.seg(['Dark','Light'],S.theme==='dark'?'Dark':'Light',l=>this.setState({theme:l.toLowerCase()}));
  vals.densitySegs=this.seg(['Compact','Comfortable'],S.density==='compact'?'Compact':'Comfortable',l=>this.setState({density:l.toLowerCase()}));
  vals.ctxSegs=this.seg(['Schema only','+ samples','None'],S.aiCtx==='Schema only'?'Schema only':S.aiCtx==='Schema + 5 sample rows'?'+ samples':'None',l=>this.setState({aiCtx:l==='+ samples'?'Schema + 5 sample rows':l==='None'?'No context':'Schema only'}));
  vals.apiKey=S.apiKey;vals.onApiKey=e=>this.setState({apiKey:e.target.value,cfg:Object.assign({},this.state.cfg,{keyState:null})});
  vals.openAiConfig=()=>this.openKind('ai','AI configuration');
  vals.safetyToggles=['Confirm destructive statements','Typed confirmation on prod connections','Block UPDATE / DELETE without WHERE','Redact literal values in query history'].map((label,i)=>{const on=S.safety[i];
   return{label,onClick:()=>this.setState(s=>{const a=s.safety.slice();a[i]=!a[i];return{safety:a}}),
    trackStyle:{width:34,height:18,borderRadius:9,background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  // ai
  vals.aiOpen=S.aiOpen;vals.aiCtx=S.aiCtx;
  vals.aiCtxSegs=this.seg(['Schema only','+ samples','None'],S.aiCtx==='Schema only'?'Schema only':S.aiCtx==='Schema + 5 sample rows'?'+ samples':'None',l=>this.setState({aiCtx:l==='+ samples'?'Schema + 5 sample rows':l==='None'?'No context':'Schema only'}),{flex:1});
  vals.ctxSamples=S.aiCtx==='Schema + 5 sample rows';
  vals.aiEmpty=S.msgs.length===0;vals.aiNoKey=!S.apiKey;
  vals.aiExamples=['count rows in orders by month','which users have no orders in 90 days?','explain the mrr_by_month view'].map(text=>({text,onClick:()=>this.askAI(text)}));
  vals.aiMsgs=S.msgs.map(m=>({who:m.who,isUser:!!m.user,text:m.text||'',streaming:!!m.streaming,
   hasSql:!!m.sql,sql:m.sql||'',showActions:!!m.sql,hasProse:!!m.prose,prose:m.prose||'',
   onInsert:()=>{this.setQs({sql:this.qs().sql+'\n\n'+m.sql});this.toast('Inserted at cursor','Nothing ran — press ⌘↵ when you are ready.','info')},
   onReplace:()=>{this.setQs({sql:m.sql,phase:'idle'});this.toast('Editor replaced',null,'info')},
   onCopy:()=>this.toast('Copied to clipboard',null,'info')}));
  vals.aiChips=(kind==='query'?[{label:'Explain selection'},{label:'Optimise'}]:[{label:'Describe this table'},{label:'Find anomalies'}]).concat(q.phase==='error'?[{label:'Fix this error'}]:[]).map(c=>({label:c.label,onClick:()=>this.askAI(c.label)}));
  vals.aiInput=S.aiInput;vals.onAiInput=e=>this.setState({aiInput:e.target.value});
  vals.onAiKey=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();if(S.aiInput.trim())this.askAI(S.aiInput.trim())}};
  vals.sendAI=()=>{if(S.aiInput.trim())this.askAI(S.aiInput.trim())};
  vals.clearAI=()=>this.setState({msgs:[]});
  // roles & privileges
  vals.isRolesTab=kind==='roles';vals.isAiTab=kind==='ai';
  const ROLES=[
   {name:'postgres',attrs:['SUPERUSER','CREATEDB','LOGIN'],conns:2,memberOf:['pg_monitor'],valid:'—',pwd:'set · scram-sha-256',sess:2},
   {name:'app',attrs:['LOGIN'],conns:14,memberOf:['app_write','app_read'],valid:'—',pwd:'set · scram-sha-256',sess:3},
   {name:'app_write',attrs:['NOLOGIN','GROUP'],conns:0,memberOf:['app_read'],valid:'—',pwd:'none',sess:0},
   {name:'app_read',attrs:['NOLOGIN','GROUP'],conns:0,memberOf:[],valid:'—',pwd:'none',sess:0},
   {name:'readonly_bi',attrs:['LOGIN'],conns:3,memberOf:['app_read'],valid:'2026-12-31',pwd:'set · scram-sha-256',sess:1},
   {name:'ci_deploy',attrs:['LOGIN','CREATEROLE'],conns:0,memberOf:['app_write'],valid:'2026-09-30',pwd:'set · scram-sha-256',sess:0}
  ];
  const attrChip=a=>({label:a,style:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',padding:'0 4px',whiteSpace:'nowrap',flex:'none',
   color:a==='SUPERUSER'?'var(--danger)':a==='GROUP'||a==='NOLOGIN'?'var(--text-muted)':'var(--text-secondary)',
   border:'1px solid '+(a==='SUPERUSER'?'var(--danger)':'var(--border-strong)')}});
  const rf=S.roleFilter.toLowerCase();
  vals.roleCount=ROLES.length;
  vals.roleFilter=S.roleFilter;vals.onRoleFilter=e=>this.setState({roleFilter:e.target.value});
  vals.roleList=ROLES.filter(r=>!rf||r.name.indexOf(rf)>=0).map(r=>({name:r.name,conns:r.conns?r.conns+' conn':'',
   attrs:r.attrs.map(attrChip),
   dotStyle:{width:6,height:6,borderRadius:'50%',flex:'none',background:r.conns?'var(--state-success)':'var(--border-strong)'},
   style:{display:'flex',flexDirection:'column',gap:5,padding:'7px 10px',cursor:'pointer',borderBottom:'1px solid var(--border-subtle)',background:S.roleSel===r.name?'var(--bg-selected)':'transparent'},
   onClick:()=>this.setState({roleSel:r.name})}));
  const R=ROLES.find(r=>r.name===S.roleSel)||ROLES[1];
  vals.role={name:R.name,attrs:R.attrs.map(attrChip),valid:R.valid,pwd:R.pwd,
   memberOf:R.memberOf.map(m=>({name:m,onRemove:()=>this.toast('REVOKE staged','revoke '+m+' from '+R.name+';','info')}))};
  const ATTRS=[['LOGIN','can open a session'],['CREATEDB','can create databases'],['CREATEROLE','can create and alter other roles'],['REPLICATION','can start streaming replication'],['BYPASSRLS','ignores every row-level security policy']];
  vals.roleAttrToggles=ATTRS.map(a=>{const key=R.name+':'+a[0];
   const on=S.attrOverride[key]!==undefined?S.attrOverride[key]:R.attrs.indexOf(a[0])>=0||(a[0]==='LOGIN'&&R.attrs.indexOf('NOLOGIN')<0);
   return{label:a[0],hint:a[1],onClick:()=>{this.setState(s=>({attrOverride:Object.assign({},s.attrOverride,{[key]:!on})}));this.toast('Staged '+(on?'NO':'')+a[0],'alter role '+R.name+' '+(on?'no':'')+a[0].toLowerCase()+';','info')},
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?(a[0]==='BYPASSRLS'?'var(--danger)':'var(--state-success)'):'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  vals.resetPwd=()=>this.toast('Password reset drafted','alter role '+R.name+" password '…'; — never logged, never in history.",'info');
  vals.addMembership=()=>this.toast('Pick a group role','The command palette lists group roles in this cluster.','info');
  vals.newRole=()=>this.toast('New role','create role … login password \'…\'; — opens as a staged statement.','info');
  vals.dropRole=()=>this.setState({confirm:{kind:'DROP ROLE',table:R.name,input:''}});
  const PRIVS=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  const PT=TREE.public.tables;
  const privT='170px repeat(7, 1fr)';
  vals.privCols=PRIVS;
  vals.privHeadStyle={display:'grid',gridTemplateColumns:privT,minWidth:620,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  const baseGrant=(role,tb,pv)=>{if(role==='postgres')return true;
   if(role==='app_read'||role==='readonly_bi')return pv==='SELECT';
   if(role==='app_write')return pv==='SELECT'||pv==='INSERT'||pv==='UPDATE';
   if(role==='app')return pv==='SELECT'||pv==='INSERT'||pv==='UPDATE'||(pv==='DELETE'&&tb!=='invoices');
   if(role==='ci_deploy')return pv==='SELECT'||pv==='TRUNCATE';
   return false};
  vals.privRows=PT.map((tb,i)=>({table:tb,
   style:{display:'grid',gridTemplateColumns:privT,minWidth:620,height:rh-6,borderTop:i?'1px solid var(--border-subtle)':'none'},
   cells:PRIVS.map(pv=>{const key=R.name+':'+tb+':'+pv;const base=baseGrant(R.name,tb,pv);
    const staged=S.grants[key]!==undefined;const on=staged?S.grants[key]:base;
    return{mark:on?'●':'·',
     markStyle:{fontSize:on?9:12,color:on?(staged?'var(--state-running)':'var(--state-success)'):'var(--text-muted)'},
     style:{display:'flex',alignItems:'center',justifyContent:'center',borderRight:'1px solid var(--border-subtle)',cursor:'pointer',background:staged?'color-mix(in oklab, var(--state-running) 14%, transparent)':'transparent'},
     onClick:()=>this.setState(s=>{const g=Object.assign({},s.grants);if(g[key]!==undefined)delete g[key];else g[key]=!base;return{grants:g}})}})}));
  const gks=Object.keys(S.grants);
  vals.hasGrantChanges=gks.length>0;vals.grantCount=gks.length;
  vals.grantReview=S.grantReview&&gks.length>0;
  vals.toggleGrantReview=()=>this.setState(s=>({grantReview:!s.grantReview}));
  vals.discardGrants=()=>this.setState({grants:{},grantReview:false});
  vals.grantSql='begin;\n'+gks.map(k=>{const p=k.split(':');return(S.grants[k]?'grant ':'revoke ')+p[2].toLowerCase()+' on public.'+p[1]+(S.grants[k]?' to ':' from ')+p[0]+';'}).join('\n')+'\ncommit;';
  vals.applyGrants=()=>{const n=gks.length;this.setState({grants:{},grantReview:false});
   this.toast('Applied '+n+(n===1?' grant':' grants'),C.ro?'Blocked — this connection is read-only.':'COMMIT · 18 ms','info')};
  const SESS=[[14882,'active','select u.id, u.email, count(o.id) …','00:00:02'],[14903,'idle in transaction','update orders set status = $1 where …','00:04:11'],[14911,'idle','—','00:31:07']].slice(0,R.sess);
  vals.hasSessions=SESS.length>0;vals.noSessions=SESS.length===0;
  vals.sessions=SESS.map((s,i)=>({pid:s[0],state:s[1],query:s[2],age:s[3],
   style:{display:'flex',alignItems:'center',gap:10,padding:'0 10px',height:rh-6,borderTop:i?'1px solid var(--border-subtle)':'none'},
   stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',width:118,flex:'none',color:s[1]==='active'?'var(--state-success)':s[1]==='idle'?'var(--text-muted)':'var(--state-running)'},
   onKill:()=>this.toast('pg_terminate_backend('+s[0]+')',C.ro?'Blocked — read-only session.':'Backend terminated.','error')}));
  // ai configuration
  const G=S.cfg;const setG=(k,v)=>this.setState(s=>({cfg:Object.assign({},s.cfg,{[k]:v})}));
  vals.testKey=()=>{setG('keyState','testing');clearTimeout(this._ak);
   this._ak=setTimeout(()=>setG('keyState',S.apiKey?'ok':'missing'),700)};
  vals.keyState=G.keyState==='testing'?'testing…':G.keyState==='ok'?'✓ Reached the API · '+G.model+' · 318 ms':G.keyState==='missing'?'✕ No key set — the panel will show a configure state instead of an error toast.':'Stored in ~/.comb/comb.db, encrypted at rest.';
  vals.keyStateStyle={fontFamily:MONO,fontSize:12,lineHeight:'18px',color:G.keyState==='ok'?'var(--state-success)':G.keyState==='missing'?'var(--state-error)':'var(--text-muted)'};
  vals.models=[['model-balanced','Balanced. The default for schema-aware SQL drafting.'],['model-large','Slower, better on 200-table schemas and gnarly window functions.'],['model-fast','Fast and cheap. Good for explain-this and error fixes.']].map(m=>({id:m[0],note:m[1],onClick:()=>setG('model',m[0]),
   style:{display:'flex',gap:9,alignItems:'flex-start',padding:'8px 10px',border:'1px solid '+(G.model===m[0]?'var(--border-strong)':'var(--border-subtle)'),borderRadius:3,cursor:'pointer',background:G.model===m[0]?'var(--bg-raised)':'transparent'},
   radioStyle:{width:12,height:12,borderRadius:'50%',flex:'none',marginTop:3,border:'1px solid '+(G.model===m[0]?'var(--text-primary)':'var(--border-strong)'),background:G.model===m[0]?'var(--text-primary)':'transparent',boxShadow:G.model===m[0]?'inset 0 0 0 2px var(--bg-base)':'none'}}));
  vals.cfgCtxSegs=this.seg(['Schema only','+ samples','None'],G.hardOff?'Schema only':(G.ctx==='samples'?'+ samples':G.ctx==='none'?'None':'Schema only'),
   l=>{if(l==='+ samples'&&G.hardOff)return this.toast('Blocked by the hard switch','Turn off “Never send row data” first.','error');
    setG('ctx',l==='+ samples'?'samples':l==='None'?'none':'schema')});
  vals.hardOff=G.hardOff;
  vals.hardOffRowStyle={display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,padding:'9px 10px',border:'1px solid '+(G.hardOff?'var(--border-strong)':'var(--border-subtle)'),borderLeft:'3px solid '+(G.hardOff?'var(--state-success)':'var(--border-strong)'),borderRadius:3};
  vals.toggleHardOff=()=>this.setState(s=>({cfg:Object.assign({},s.cfg,{hardOff:!s.cfg.hardOff,ctx:!s.cfg.hardOff?'schema':s.cfg.ctx})}));
  vals.hardTrackStyle={width:34,height:18,borderRadius:9,flex:'none',background:G.hardOff?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:G.hardOff?'flex-end':'flex-start'};
  vals.hardKnobStyle={width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'};
  vals.samples=G.samples;vals.onSamples=e=>setG('samples',Number(e.target.value));
  vals.sampleLabelStyle={fontSize:13,lineHeight:'18px',color:G.hardOff?'var(--text-muted)':'var(--text-primary)'};
  vals.sliderStyle={width:'100%',accentColor:'var(--text-primary)',opacity:G.hardOff?.4:1};
  vals.budget=G.budget;vals.onBudget=e=>setG('budget',Number(e.target.value));
  vals.patterns=G.redact.map(p=>({name:p,onRemove:()=>setG('redact',G.redact.filter(x=>x!==p))}));
  vals.newPat=G.newPat;vals.onNewPat=e=>setG('newPat',e.target.value);
  const addPat=()=>{const v=G.newPat.trim();if(!v)return;this.setState(s=>({cfg:Object.assign({},s.cfg,{redact:s.cfg.redact.concat([v]),newPat:''})}))};
  vals.addPat=addPat;vals.onNewPatKey=e=>{if(e.key==='Enter'){e.preventDefault();addPat()}};
  vals.featToggles=[['F-50','Natural language → SQL draft'],['F-51','Explain this query'],['F-52','Fix this error, offered inline on failure'],['F-53','Optimise / suggest indexes from EXPLAIN'],['F-54','Explain this result set'],['F-57','Follow-up conversation with query context']].map((f,i)=>{const on=G.feats[i];
   return{id:f[0],label:f[1],onClick:()=>this.setState(s=>{const a=s.cfg.feats.slice();a[i]=!a[i];return{cfg:Object.assign({},s.cfg,{feats:a})}}),
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  const withSamples=!G.hardOff&&G.ctx==='samples';
  vals.payload='-- system: PostgreSQL 16.3 · public · output contract\ncreate table public.users (\n  id bigint not null,           -- pk\n  email text not null,          -- unique\n  plan text not null default \'free\',\n  mrr numeric(10,2),\n  created_at timestamptz not null,\n  org_id uuid                    -- fk → orgs(id)\n);  -- ~48,201 rows\n\ncreate table public.orders (\n  id bigint not null,           -- pk\n  user_id bigint not null,      -- fk → users(id)\n  status text not null,\n  created_at timestamptz not null\n);  -- ~131,004 rows'+(G.ctx==='none'?'':'')+(withSamples?'\n\n-- 5 sample rows per table\nusers: (1, \'ana1@example.com\', \'pro\', 249.00, \'2024-01-14 09:12\', 8c1f…)\n       (2, \'ben2@example.com\', \'free\', null, \'2024-01-14 11:40\', 4ab0…)\npassword_hash: \'***\'  -- redacted by pattern':'');
  if(G.ctx==='none')vals.payload='-- context mode: none\n-- only your prompt and the SQL you selected is sent.\n-- no table names, no columns, no rows.';
  const est=G.ctx==='none'?0.4:(withSamples?3.1:1.8);
  vals.tokenEst='≈ '+est.toFixed(1)+'k / '+G.budget+'k';
  vals.tokenStyle={fontFamily:MONO,fontSize:11,color:est>G.budget?'var(--state-error)':'var(--text-secondary)'};
  vals.payloadNote=G.ctx==='none'?'Nothing about the schema leaves the machine.':withSamples?G.samples+' rows per table, redacted on '+G.redact.length+' patterns. Serialized as compact DDL — models read it better and it costs fewer tokens.':'Schema only: DDL of the tables in scope, no rows. Cached against a catalog version hash.';
  vals.contractRules=[{text:'One fenced sql block, then assumptions as prose — never the other way round.'},{text:'Explicit JOIN syntax; qualify columns when more than one table is involved.'},{text:'Never invent a column — say what is missing and ask.'},{text:'LIMIT on exploratory selects.'},{text:'Identifier casing taken from the catalog, quoted when required.'}];
  // audit trail
  vals.isAuditTab=kind==='audit';vals.isTeamTab=kind==='team';vals.isMonitorTab=kind==='monitor';
  const AUD=[
   ['ev-8841','14:02:11','maya.k','analytics_prod','SELECT','users, orders',60,'240 ms','ok'],
   ['ev-8840','13:58:04','ci_deploy','shop_staging','MIGRATE','+2 indexes',0,'8.4 s','ok'],
   ['ev-8839','13:51:37','tom.r','shop_staging','UPDATE','orders',412,'1.2 s','ok'],
   ['ev-8838','13:44:02','tom.r','shop_staging','DELETE','order_items',0,'38 ms','blocked'],
   ['ev-8837','13:30:55','maya.k','analytics_prod','GRANT','readonly_bi',0,'12 ms','ok'],
   ['ev-8836','12:59:18','sam.d','shop_local','TRUNCATE','events',48201,'61 ms','ok'],
   ['ev-8835','12:41:09','maya.k','analytics_prod','SELECT','invoices',1000,'4.1 s','ok'],
   ['ev-8834','12:22:47','tom.r','shop_staging','ROLLBACK','orders',0,'2 ms','failed'],
   ['ev-8833','11:58:31','sam.d','shop_local','INSERT','users',3,'9 ms','ok'],
   ['ev-8832','11:40:12','svc_export','analytics_prod','EXPORT','mrr_by_month',9812,'22 s','ok'],
   ['ev-8831','11:12:03','maya.k','analytics_prod','EXPLAIN','orders',0,'18 ms','ok'],
   ['ev-8830','10:47:55','tom.r','shop_staging','DROP','tmp_backfill',0,'31 ms','ok']
  ];
  const kindColor=k=>({SELECT:'var(--state-info)',EXPLAIN:'var(--state-info)',EXPORT:'var(--state-info)',INSERT:'var(--state-success)',UPDATE:'var(--state-running)',GRANT:'var(--type-identifier)',MIGRATE:'var(--type-temporal)',DELETE:'var(--danger)',TRUNCATE:'var(--danger)',DROP:'var(--danger)',ROLLBACK:'var(--text-muted)'}[k]||'var(--text-secondary)');
  const aq=S.auditQ.toLowerCase();
  const auditFilterDefs=[['actor',['All','maya.k','tom.r','sam.d']],['kind',['All','Writes','Reads','Schema']],['window',['24h','7d','30d']]];
  vals.auditFilters=auditFilterDefs.map(d=>({label:d[0],opts:d[1].map(o=>({label:o,onClick:()=>this.setState(s=>({auditF:Object.assign({},s.auditF,{[d[0]]:o})})),
   style:{padding:'0 7px',fontSize:11,fontFamily:COND,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',whiteSpace:'nowrap',
    background:(S.auditF[d[0]]||d[1][0])===o?'var(--bg-selected)':'transparent',color:(S.auditF[d[0]]||d[1][0])===o?'var(--text-primary)':'var(--text-muted)',borderRight:'1px solid var(--border-subtle)'}}))}));
  const fActor=S.auditF.actor||'All',fKind=S.auditF.kind||'All';
  const WRITES=['INSERT','UPDATE','DELETE','TRUNCATE'],READS=['SELECT','EXPLAIN','EXPORT'],SCHEMA=['MIGRATE','DROP','GRANT'];
  const audFiltered=AUD.filter(a=>(fActor==='All'||a[2]===fActor)
   &&(fKind==='All'||(fKind==='Writes'?WRITES.indexOf(a[4])>=0:fKind==='Reads'?READS.indexOf(a[4])>=0:SCHEMA.indexOf(a[4])>=0))
   &&(!aq||(a[2]+a[3]+a[4]+a[5]).toLowerCase().indexOf(aq)>=0));
  vals.auditQ=S.auditQ;vals.onAuditQ=e=>this.setState({auditQ:e.target.value});
  vals.auditCount=audFiltered.length+' of '+AUD.length+' events';
  vals.auditChain='sha256 …a91f · verified';
  const audT='96px 96px 150px 96px 168px 74px 78px 108px';
  vals.auditHeadStyle={display:'grid',gridTemplateColumns:audT,minWidth:860,position:'sticky',top:0,zIndex:2,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  const connOf=n=>S.conns.find(c=>c.name===n)||S.conns[0];
  vals.auditRows=audFiltered.map(a=>({when:a[1],actor:a[2],conn:a[3],kind:a[4],target:a[5],rows:a[6]?a[6].toLocaleString():'—',ms:a[7],status:a[8]==='ok'?'✓ ok':a[8]==='blocked'?'⃠ blocked':'✕ failed',
   style:{display:'grid',gridTemplateColumns:audT,minWidth:860,height:rh,borderBottom:'1px solid var(--border-subtle)',cursor:'pointer',background:S.auditSel===a[0]?'var(--bg-selected)':'transparent'},
   cell:{display:'flex',alignItems:'center',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},
   numCell:{display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,fontVariantNumeric:'tabular-nums',color:'var(--text-secondary)'},
   barStyle:{width:2,height:14,flex:'none',background:this.idc(connOf(a[3]))},
   kindStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:kindColor(a[4]),whiteSpace:'nowrap'},
   statusStyle:{fontFamily:MONO,fontSize:12,whiteSpace:'nowrap',color:a[8]==='ok'?'var(--state-success)':a[8]==='blocked'?'var(--state-running)':'var(--state-error)'},
   onClick:()=>this.setState({auditSel:a[0]})}));
  vals.auditEmpty=audFiltered.length===0;
  const AS=AUD.find(a=>a[0]===S.auditSel);
  vals.auditSel=!!AS;
  vals.audit=AS?{id:AS[0],rows:AS[6],sql:AS[4]==='UPDATE'?"update public.orders\n   set status = 'shipped'\n where shipped_at is not null\n   and status = 'paid';":AS[4]==='SELECT'?"select u.id, u.email, count(o.id) as orders\nfrom users u\nleft join orders o on o.user_id = u.id\nwhere u.created_at > now() - interval '30 days'\ngroup by 1, 2;":AS[4]==='GRANT'?'grant select on all tables in schema public to readonly_bi;':'-- '+AS[4]+' on '+AS[5]}:{id:'',rows:0,sql:''};
  vals.auditMeta=AS?[['event',AS[0]],['actor',AS[2]+' · maya.k@acme.com'],['auth',AS[2]==='ci_deploy'||AS[2]==='svc_export'?'service token':'SAML · Okta · MFA'],['connection',AS[3]+' ('+connOf(AS[3]).env+')'],['db role',AS[2]==='ci_deploy'?'ci_deploy':'app'],['client',AS[2].indexOf('svc')===0?'10.4.1.19 · comb-worker':'10.2.7.44 · Comb 1.4.2 (macOS)'],['session','sid-4f81c2 · pid 14882'],['transaction','xid 918233 · committed'],['duration',AS[7]],['rows affected',String(AS[6])],['statement hash','q7c1…f0'],['approval',WRITES.indexOf(AS[4])>=0||SCHEMA.indexOf(AS[4])>=0?'approved by maya.k · 13:50':'not required']]
   .map(m=>({k:m[0],v:m[1]})):[];
  vals.auditHasDiff=!!(AS&&AS[4]==='UPDATE');
  vals.auditDiff=vals.auditHasDiff?[['-',"(88213, 'paid',    '2026-08-12 09:11')"],['+',"(88213, 'shipped', '2026-08-12 09:11')"],['-',"(88219, 'paid',    '2026-08-12 09:14')"]].map((d,i)=>({sign:d[0],text:d[1],
   style:{display:'flex',alignItems:'center',gap:8,padding:'0 10px',height:24,borderTop:i?'1px solid var(--border-subtle)':'none',background:d[0]==='-'?'color-mix(in oklab, var(--danger) 9%, transparent)':'color-mix(in oklab, var(--state-success) 9%, transparent)'},
   signStyle:{fontFamily:MONO,fontSize:12,width:8,flex:'none',color:d[0]==='-'?'var(--danger)':'var(--state-success)'}})):[];
  vals.closeAudit=()=>this.setState({auditSel:null});
  vals.exportAudit=()=>this.toast('Export queued',audFiltered.length+' events · CSV · signed download link valid 10 minutes','info');
  vals.auditReopen=()=>{this.newQueryTab();this.toast('Opened in a query tab','Not run — the trail is a record, not a shortcut.','info')};
  vals.auditRevert=()=>this.toast('Compensating SQL drafted',"update public.orders set status = 'paid' where id in (…412 ids); — review before running.",'info');
  // team & access
  const MEM=[
   ['Maya Kaur','maya.k@acme.com','Owner','SAML',true,4,'2 min ago','active'],
   ['Tom Reyes','tom.r@acme.com','Admin','SAML',true,3,'18 min ago','active'],
   ['Sam Diaz','sam.d@acme.com','Analyst','SAML',true,2,'yesterday','active'],
   ['Ines Prat','ines.p@acme.com','Analyst','Password',false,1,'6 days ago','active'],
   ['Ravi Shah','ravi.s@acme.io','Viewer','SAML',true,1,'—','invited'],
   ['svc_export','tokens/svc_export','Service','Token',false,1,'11:40','active']
  ];
  const roleColor=r=>r==='Owner'?'var(--danger)':r==='Admin'?'var(--state-running)':r==='Service'?'var(--type-identifier)':r==='Viewer'?'var(--text-muted)':'var(--state-info)';
  const memT='210px 122px 118px 140px 116px 156px';
  vals.memberHeadStyle={display:'grid',gridTemplateColumns:memT,minWidth:860,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.memberSummary=MEM.filter(m=>m[7]==='active').length+' active · 1 invited · 1 service identity';
  const ROLE_CYCLE=['Viewer','Analyst','Admin','Owner'];
  vals.members=MEM.map((m,i)=>{const role=S.memberRoles[m[1]]||m[2];
   return{name:m[0],email:m[1],role,auth:m[3],mfa:m[4],seen:m[6],status:m[7]==='invited'?'invited':'active',removeLabel:m[7]==='invited'?'resend':'remove',
    style:{display:'grid',gridTemplateColumns:memT,minWidth:860,height:rh+8,borderBottom:i<MEM.length-1?'1px solid var(--border-subtle)':'none'},
    roleStyle:{height:22,padding:'0 8px',border:'1px solid var(--border-strong)',borderRadius:3,fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:roleColor(role),whiteSpace:'nowrap'},
    authStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:m[3]==='Password'?'var(--state-running)':'var(--text-secondary)',whiteSpace:'nowrap'},
    statusStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:m[7]==='invited'?'var(--state-running)':'var(--state-success)',whiteSpace:'nowrap'},
    connLabel:m[5]+'/4',
    connDots:S.conns.map(c=>({title:c.name,style:{width:6,height:6,borderRadius:'50%',flex:'none',background:this.idc(c),opacity:S.conns.indexOf(c)<m[5]?1:.22}})),
    onRole:()=>{if(m[2]==='Service')return this.toast('Service identities have fixed scope','Rotate or revoke its token instead.','info');
     const nx=ROLE_CYCLE[(ROLE_CYCLE.indexOf(role)+1)%ROLE_CYCLE.length];
     this.setState(s=>({memberRoles:Object.assign({},s.memberRoles,{[m[1]]:nx})}));this.toast(m[0]+' → '+nx,'Takes effect on their next request.','info')},
    onRemove:()=>this.toast(m[7]==='invited'?'Invite resent to '+m[1]:'Remove '+m[0]+'?','Their sessions are revoked immediately; the audit trail keeps their history.',m[7]==='invited'?'info':'error')}});
  vals.inviteMember=()=>this.toast('Invite drafted','SAML domains are enforced — only acme.com and acme.io addresses can be invited.','info');
  vals.ssoStatus=S.sso?'ENABLED':'DISABLED';
  vals.ssoStatusStyle={fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',padding:'1px 5px',whiteSpace:'nowrap',background:S.sso?'var(--state-success)':'transparent',color:S.sso?'var(--text-inverse)':'var(--text-muted)',border:S.sso?'none':'1px solid var(--border-strong)'};
  vals.toggleSso=()=>this.setState(s=>({sso:!s.sso}));
  vals.ssoTrackStyle={width:34,height:18,borderRadius:9,flex:'none',background:S.sso?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:S.sso?'flex-end':'flex-start'};
  vals.ssoKnobStyle={width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'};
  vals.ssoToggles=[['Enforce SSO only','Password sign-in stops working, including for owners.'],['Just-in-time provisioning','Create the member on first successful assertion.'],['Require MFA claim','Reject assertions without an amr MFA value.'],['SCIM deprovisioning','Removing them in the IdP revokes Comb sessions within a minute.']].map((t,i)=>{const on=S.ssoOpts[i];
   return{label:t[0],hint:t[1],onClick:()=>this.setState(s=>{const a=s.ssoOpts.slice();a[i]=!a[i];return{ssoOpts:a}}),
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  vals.groupMaps=[['acme-data-platform','Owner'],['acme-data-eng','Admin'],['acme-analysts','Analyst'],['acme-everyone','Viewer']].map((g,i)=>({group:g[0],role:g[1],
   style:{display:'flex',alignItems:'center',gap:9,padding:'0 10px',height:rh-4,borderTop:i?'1px solid var(--border-subtle)':'none'},
   roleStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:roleColor(g[1]),whiteSpace:'nowrap',width:64},
   onRemove:()=>this.toast('Mapping removed','Members from '+g[0]+' lose access on next sign-in.','error')}));
  vals.addGroupMap=()=>this.toast('Group mapping','Comb reads groups from the assertion — paste the IdP group name exactly.','info');
  const LVL=['none','read','write','admin'];
  const accT='150px repeat(4, minmax(96px,1fr))';
  vals.accessHeadStyle={display:'grid',gridTemplateColumns:accT,minWidth:600,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.accessCols=S.conns.map(c=>({name:c.name,barStyle:{width:2,height:12,flex:'none',background:this.idc(c)}}));
  vals.accessRows=MEM.slice(0,5).map((m,i)=>({name:m[0],
   style:{display:'grid',gridTemplateColumns:accT,minWidth:600,height:rh-4,borderTop:i?'1px solid var(--border-subtle)':'none'},
   cells:S.conns.map((c,j)=>{const key=m[1]+':'+c.id;
    const base=j<m[5]?(m[2]==='Owner'?'admin':m[2]==='Admin'?(c.env==='prod'?'read':'write'):m[2]==='Viewer'?'read':(c.env==='prod'?'read':'write')):'none';
    const lvl=S.access[key]||base;
    return{label:lvl,
     labelStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',
      color:lvl==='none'?'var(--text-muted)':lvl==='read'?'var(--state-info)':lvl==='write'?'var(--state-running)':'var(--danger)'},
     style:{display:'flex',alignItems:'center',justifyContent:'center',borderRight:'1px solid var(--border-subtle)',cursor:'pointer',
      background:S.access[key]?'color-mix(in oklab, var(--state-running) 12%, transparent)':'transparent'},
     onClick:()=>this.setState(s=>({access:Object.assign({},s.access,{[key]:LVL[(LVL.indexOf(lvl)+1)%4]})}))}})}));
  // monitoring
  vals.liveLabel=S.live?'live · 5s':'paused';
  vals.liveBtn=S.live?'⏸ Pause':'▶ Resume';
  vals.toggleLive=()=>this.setState(s=>({live:!s.live}));
  vals.liveDotStyle={width:7,height:7,borderRadius:'50%',flex:'none',background:S.live?'var(--state-success)':'var(--text-muted)',animation:S.live?'combpulse 1.6s ease-in-out infinite':'none'};
  vals.rangeSegs=this.seg(['1h','6h','24h','7d'],S.range,l=>this.setState({range:l}));
  const spark=(seed,n)=>{const out=[];for(let i=0;i<n;i++)out.push(0.25+rnd(seed,i)*0.75);return out};
  const KPI=[
   ['Connections','62','/ 200',spark(3,14),'peak 118 at 09:40','ok'],
   ['Transactions','1.4','k/s',spark(5,14),'+12% vs yesterday','ok'],
   ['Cache hit','99.2','%',spark(7,14),'shared_buffers 8 GB','ok'],
   ['Replica lag','1.8','s',spark(9,14),'replica-2 · threshold 5 s','warn'],
   ['Longest query','4.1','s',spark(11,14),'pid 14903 · idle in transaction','warn'],
   ['Deadlocks','2','today',spark(13,14),'both on public.orders','err']
  ];
  vals.kpis=KPI.map(k=>({value:k[1],unit:k[2],label:k[0],note:k[4],
   valueStyle:{fontFamily:MONO,fontSize:24,lineHeight:'30px',fontWeight:500,fontVariantNumeric:'tabular-nums',color:k[5]==='err'?'var(--state-error)':k[5]==='warn'?'var(--state-running)':'var(--text-primary)'},
   noteStyle:{fontSize:11,lineHeight:'15px',color:'var(--text-muted)'},
   style:{display:'flex',flexDirection:'column',gap:6,padding:'10px 11px',border:'1px solid var(--border-subtle)',borderLeft:'3px solid '+(k[5]==='err'?'var(--state-error)':k[5]==='warn'?'var(--state-running)':'var(--border-strong)'),borderRadius:3,background:'var(--bg-raised)'},
   bars:k[3].map(v=>({style:{flex:1,height:Math.round(v*22)+'px',background:k[5]==='err'?'color-mix(in oklab, var(--state-error) 55%, transparent)':k[5]==='warn'?'color-mix(in oklab, var(--state-running) 55%, transparent)':'var(--border-strong)'}}))}));
  vals.hasAlerts=S.alerts.length>0;
  const ALERTDEF={a1:['warn','Replica lag above 1.5 s for 6 minutes','replica-2 is behind on WAL apply. Read queries routed there may return stale rows.','6 min'],
   a2:['err','Deadlock detected twice on public.orders','Two backends updated the same rows in opposite order. Statements captured in the trail.','41 min'],
   a3:['warn','users_metadata_gin unused in 30 days','0 scans, 412 MB. Dropping it would speed up writes on a 48k-row table.','2 h']};
  vals.alerts=S.alerts.map(id=>{const a=ALERTDEF[id];return{sev:a[0]==='err'?'CRITICAL':'WARNING',title:a[1],body:a[2],age:a[3],
   sevStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',width:66,flex:'none',color:a[0]==='err'?'var(--state-error)':'var(--state-running)'},
   style:{display:'flex',alignItems:'flex-start',gap:10,padding:'9px 11px',border:'1px solid var(--border-subtle)',borderLeft:'3px solid '+(a[0]==='err'?'var(--state-error)':'var(--state-running)'),borderRadius:3,background:'var(--bg-raised)'},
   onAck:()=>{this.setState(s=>({alerts:s.alerts.filter(x=>x!==id)}));this.toast('Alert acknowledged','Silenced for 4 hours. It reopens if the condition persists.','info')}}});
  vals.slowSegs=this.seg(['Total time','Mean','Calls'],S.slowSort,l=>this.setState({slowSort:l}));
  const SLOW=[
   ['select u.id, u.email, count(o.id) from users u left join orders o …',18422,'240 ms','73.7 min',31],
   ['update orders set status = $1 where shipped_at is not null and …',412,'1.2 s','8.2 min',18],
   ['select * from order_items where order_id = $1',904113,'2 ms','30.1 min',14],
   ['select date_trunc($1, created_at), sum(mrr) from users group by 1',2201,'890 ms','32.6 min',12],
   ['insert into events (kind, payload, created_at) values ($1, $2, $3)',1204882,'0.4 ms','8.0 min',9],
   ['select * from invoices where org_id = $1 order by created_at desc',44120,'38 ms','27.9 min',7]
  ];
  const slowT='minmax(280px,1fr) 92px 88px 96px 190px';
  vals.slowHeadStyle={display:'grid',gridTemplateColumns:slowT,minWidth:760,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  const slowSorted=SLOW.slice().sort((a,b)=>S.slowSort==='Calls'?b[1]-a[1]:S.slowSort==='Mean'?parseFloat(b[2])-parseFloat(a[2]):b[4]-a[4]);
  vals.slowRows=slowSorted.map((s,i)=>({sql:s[0],calls:s[1].toLocaleString(),mean:s[2],total:s[3],share:s[4]+'%',
   style:{display:'grid',gridTemplateColumns:slowT,minWidth:760,height:rh,borderTop:i?'1px solid var(--border-subtle)':'none'},
   numCell:{display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,fontVariantNumeric:'tabular-nums',color:'var(--text-secondary)'},
   meanCell:{display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,fontVariantNumeric:'tabular-nums',color:parseFloat(s[2])>=1&&s[2].indexOf('s')>0?'var(--state-running)':'var(--text-secondary)'},
   barStyle:{width:Math.round(s[4]*2.2)+'px',height:6,background:'var(--state-info)',borderRadius:3,flex:'none'},
   onOpen:()=>{this.newQueryTab();this.toast('EXPLAIN drafted','explain (analyze, buffers) '+s[0].slice(0,34)+'… — run it when the load allows.','info')}}));
  vals.lockRows=[[14903,'BLOCKS','ShareRowExclusive on public.orders (2 waiters)','00:04:11'],[14921,'waiting','update public.orders set status = $1 where id = $2','00:02:58'],[14930,'waiting','delete from public.order_items where order_id = $1','00:01:04'],[14882,'running','select … from users u left join orders o','00:00:02']].map((l,i)=>({pid:l[0],tag:l[1],text:l[2],wait:l[3],
   style:{display:'flex',alignItems:'center',gap:9,padding:'0 10px',height:rh-4,borderTop:i?'1px solid var(--border-subtle)':'none',paddingLeft:l[1]==='waiting'?26:10,background:l[1]==='BLOCKS'?'color-mix(in oklab, var(--state-error) 8%, transparent)':'transparent'},
   tagStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',width:62,flex:'none',color:l[1]==='BLOCKS'?'var(--state-error)':l[1]==='waiting'?'var(--state-running)':'var(--state-success)'},
   onKill:()=>this.toast('pg_terminate_backend('+l[0]+')',l[1]==='BLOCKS'?'Two waiters released immediately.':'Backend terminated.','error')}));
  vals.healthRows=[['events','2.4 GB',62,'62%','never'],['order_items','1.1 GB',34,'34%','2 h ago'],['orders','412 MB',18,'18%','40 min ago'],['users','96 MB',7,'7%','12 min ago'],['invoices','188 MB',29,'29%','5 h ago']].map((h,i)=>({table:h[0],size:h[1],bloat:h[3],vac:h[4],
   style:{display:'flex',alignItems:'center',gap:9,padding:'0 10px',height:rh-6,borderTop:i?'1px solid var(--border-subtle)':'none'},
   fillStyle:{display:'block',height:'100%',width:h[2]+'%',background:h[2]>=50?'var(--state-error)':h[2]>=30?'var(--state-running)':'var(--state-success)'},
   bloatStyle:{fontFamily:MONO,fontSize:11,width:36,flex:'none',textAlign:'right',color:h[2]>=50?'var(--state-error)':h[2]>=30?'var(--state-running)':'var(--text-secondary)'}}));
  // migrations
  vals.isMigrationsTab=kind==='migrations';vals.isJobsTab=kind==='jobs';vals.isApprovalsTab=kind==='approvals';
  const MIGS=[
   ['20260814_1140','add_orders_shipped_at_index','pending','maya.k','2 statements','concurrent'],
   ['20260812_0902','backfill_users_org_id','applied','tom.r','4 statements','locking'],
   ['20260809_1655','create_invoices_table','applied','tom.r','3 statements','safe'],
   ['20260805_1402','add_plan_tier_enum','applied','maya.k','2 statements','safe'],
   ['20260731_1120','drop_legacy_sessions','failed','sam.d','1 statement','locking'],
   ['20260728_0844','enable_rls_on_users','applied','maya.k','3 statements','safe'],
   ['20260721_1601','init_schema','applied','tom.r','18 statements','safe']
  ];
  const migState=s=>s==='applied'?'var(--state-success)':s==='pending'?'var(--state-running)':'var(--state-error)';
  vals.migSummary='6 applied · 1 pending · 1 failed · no drift';
  vals.migList=MIGS.map(m=>({version:m[0],name:m[1],state:m[2].toUpperCase(),meta:m[3]+' · '+m[4],
   dotStyle:{width:6,height:6,borderRadius:'50%',flex:'none',background:migState(m[2])},
   stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:migState(m[2]),whiteSpace:'nowrap'},
   style:{display:'flex',flexDirection:'column',gap:4,padding:'8px 10px',cursor:'pointer',borderBottom:'1px solid var(--border-subtle)',background:S.migSel===m[0]?'var(--bg-selected)':'transparent'},
   onClick:()=>this.setState({migSel:m[0]})}));
  const MG=MIGS.find(m=>m[0]===S.migSel)||MIGS[0];
  vals.mig={version:MG[0],name:MG[1]};
  vals.migFacts=[['Author',MG[3],'text'],['Statements',MG[4].split(' ')[0],'num'],['Est. duration',MG[5]==='concurrent'?'~40 s':'~2 s','num'],['Lock risk',MG[5],MG[5]==='safe'?'ok':'warn']].map(k=>({label:k[0],value:k[1],
   valueStyle:{fontFamily:k[2]==='num'?MONO:'inherit',fontSize:k[2]==='text'?13:16,lineHeight:'22px',fontWeight:500,color:k[3]==='warn'?'var(--state-running)':'var(--text-primary)'}}));
  vals.migHasLock=MG[5]!=='safe';
  vals.migLockTitle=MG[5]==='concurrent'?'Runs outside a transaction':'Takes an ACCESS EXCLUSIVE lock';
  vals.migLockBody=MG[5]==='concurrent'?'CREATE INDEX CONCURRENTLY cannot be wrapped in BEGIN. A failure leaves an invalid index behind that you must drop by hand — that is Postgres, not Comb.':'Reads and writes on public.orders block for the duration. On a 131k-row table expect a few seconds; on prod, schedule it.';
  vals.migDirSegs=this.seg(['Up','Down'],S.migDir,l=>this.setState({migDir:l}));
  const UP=['begin;','','-- shipped_at is queried on every fulfilment dashboard','create index concurrently if not exists','  orders_shipped_at_idx','  on public.orders using btree (shipped_at desc nulls last);','','comment on index orders_shipped_at_idx is','  \'added 2026-08-14 for fulfilment dashboard\';','','commit;'];
  const DOWN=['begin;','','drop index if exists public.orders_shipped_at_idx;','','commit;'];
  vals.migLines=(S.migDir==='Down'?DOWN:UP).map((l,i)=>({n:i+1,text:l,
   style:{fontFamily:MONO,fontSize:12,lineHeight:'19px',whiteSpace:'pre',color:l.indexOf('--')===0?'var(--text-muted)':/^(begin|commit|create|drop|comment)/.test(l)?'var(--text-primary)':'var(--text-secondary)'}}));
  vals.migDiff=[['+','index orders_shipped_at_idx on orders (shipped_at desc)','412 MB est'],['~','table orders — write path +1 index','~4% slower inserts'],['+','comment on orders_shipped_at_idx','—']].map((d,i)=>({sign:d[0],text:d[1],note:d[2],
   style:{display:'flex',alignItems:'center',gap:9,padding:'0 10px',height:rh-6,borderTop:i?'1px solid var(--border-subtle)':'none',background:d[0]==='+'?'color-mix(in oklab, var(--state-success) 8%, transparent)':d[0]==='-'?'color-mix(in oklab, var(--danger) 8%, transparent)':'transparent'},
   signStyle:{fontFamily:MONO,fontSize:12,width:8,flex:'none',color:d[0]==='+'?'var(--state-success)':d[0]==='-'?'var(--danger)':'var(--state-running)'}}));
  vals.migEnvs=S.conns.map(c=>{const applied=MG[2]==='applied'||c.env==='local'||c.env==='dev';
   return{name:c.name,state:applied?'APPLIED':'PENDING',when:applied?'2026-08-12 09:04':'—',
    barStyle:{width:2,height:12,flex:'none',background:this.idc(c)},
    stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:applied?'var(--state-success)':'var(--state-running)'},
    style:{flex:'1 1 150px',display:'flex',flexDirection:'column',gap:3,padding:'8px 10px',border:'1px solid var(--border-subtle)',borderRadius:3,background:'var(--bg-raised)'}}});
  vals.migDryRun=()=>this.toast('Dry run on a schema branch','2 statements parsed · lock analysis done · 0 errors. Nothing touched the real catalog.','success');
  vals.migApplyLabel=C.ro?'Apply — blocked':'Apply to '+C.name;
  vals.migApplyStyle={height:26,padding:'0 12px',borderRadius:3,fontSize:12,fontWeight:500,whiteSpace:'nowrap',
   background:C.ro?'var(--bg-hover)':'var(--btn-primary)',color:C.ro?'var(--text-muted)':'var(--text-inverse)',cursor:C.ro?'not-allowed':'pointer'};
  vals.migApply=()=>C.ro?this.toast('Blocked','This connection is read-only. Migrations run through the deploy identity, not an analyst session.','error')
   :this.setState({confirm:{kind:'APPLY MIGRATION',table:MG[0],input:''}});
  vals.newMigration=()=>this.toast('New migration','Comb writes the version stamp; you write the statements. Down migration is required before it can be applied to prod.','info');
  vals.driftCheck=()=>this.toast('No drift','Live catalog matches the applied set on all four connections. Checked 42 tables, 61 indexes, 12 constraints.','success');
  // scheduled jobs
  const JOBS=[
   ['j1','MRR weekly report','query → email','0 7 * * MON','analytics_prod','finance@acme.com','active',[1,1,1,1,1,1,1],'Mon 07:00'],
   ['j2','Nightly full export','export → S3','0 2 * * *','analytics_prod','s3://acme-warehouse/comb/','active',[1,1,1,0,1,1,1],'02:00'],
   ['j3','Stuck orders alert','query → Slack','*/15 * * * *','shop_staging','#ops-alerts','active',[1,1,1,1,1,1,1],'in 4 min'],
   ['j4','Vacuum analyze events','maintenance','0 4 * * SUN','shop_staging','—','active',[1,1,0,1,1,1,1],'Sun 04:00'],
   ['j5','Churn cohort refresh','query → table','30 3 * * *','analytics_prod','analytics.cohorts','paused',[1,1,1,1,0,0,0],'—'],
   ['j6','PII scan','compliance','0 6 * * *','all connections','compliance@acme.com','active',[1,1,1,1,1,1,2],'06:00']
  ];
  vals.jobSegs=this.seg(['All','Active','Paused'],S.jobFilter,l=>this.setState({jobFilter:l}));
  const jobsF=JOBS.filter(j=>S.jobFilter==='All'||(S.jobFilter==='Active'?j[6]==='active':j[6]==='paused'));
  vals.jobSummary=jobsF.length+' jobs · 1 failure in 7 days · next run in 4 min';
  const jobT='190px 130px 150px 190px 96px 96px 130px';
  vals.jobHeadStyle={display:'grid',gridTemplateColumns:jobT,minWidth:900,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.jobRows=jobsF.map((j,i)=>{const paused=(S.jobPaused[j[0]]!==undefined?S.jobPaused[j[0]]:j[6]==='paused');
   return{name:j[1],kind:j[2],cron:j[3],conn:j[4],dest:j[5],next:paused?'—':j[8],state:paused?'PAUSED':'ACTIVE',toggleLabel:paused?'resume':'pause',
    style:{display:'grid',gridTemplateColumns:jobT,minWidth:900,height:rh+8,borderBottom:i<jobsF.length-1?'1px solid var(--border-subtle)':'none',cursor:'pointer',opacity:paused?.62:1,background:S.jobSel===j[0]?'var(--bg-selected)':'transparent'},
    barStyle:{width:2,height:12,flex:'none',background:j[4]==='all connections'?'var(--text-muted)':this.idc(connOf(j[4]))},
    stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',whiteSpace:'nowrap',color:paused?'var(--text-muted)':'var(--state-success)'},
    runs:j[7].map((r,k)=>({title:'run '+(k+1)+(r===1?' ok':r===2?' running':' failed'),
     style:{width:7,height:14,flex:'none',background:r===1?'var(--state-success)':r===2?'var(--state-running)':'var(--state-error)',opacity:r===1?.75:1}})),
    onClick:()=>this.setState({jobSel:j[0]}),
    onToggle:e=>{e.stopPropagation();this.setState(s=>({jobPaused:Object.assign({},s.jobPaused,{[j[0]]:!paused})}));this.toast(j[1]+(paused?' resumed':' paused'),paused?'Next run '+j[8]:'No further runs until resumed.','info')}}});
  const JB=JOBS.find(j=>j[0]===S.jobSel);
  vals.jobSel=!!JB;vals.job=JB?{name:JB[1]}:{name:''};
  vals.jobHistory=JB?[['2026-08-14 07:00','9,812 rows · 412 KB · delivered','4.1 s',0],['2026-08-07 07:00','9,640 rows · 402 KB · delivered','3.8 s',0],['2026-07-31 07:00','SMTP timeout after 3 retries','92 s',1],['2026-07-24 07:00','9,201 rows · 388 KB · delivered','3.9 s',0],['2026-07-17 07:00','9,118 rows · 381 KB · delivered','4.4 s',0],['2026-07-10 07:00','8,904 rows · 372 KB · delivered','3.7 s',0]].map((h,i)=>({when:h[0].slice(5),detail:h[1],dur:h[2],failed:!!h[3],
   dotStyle:{width:6,height:6,borderRadius:'50%',flex:'none',background:h[3]?'var(--state-error)':'var(--state-success)'},
   style:{display:'flex',alignItems:'center',gap:9,padding:'0 10px',height:rh-4,borderTop:i?'1px solid var(--border-subtle)':'none',background:h[3]?'color-mix(in oklab, var(--state-error) 8%, transparent)':'transparent'},
   onRetry:()=>this.toast('Re-running '+JB[1],'Ad-hoc run queued. It does not shift the schedule.','info')})):[];
  vals.jobSql=JB?(JB[2].indexOf('query')===0?"select date_trunc('month', created_at) as month,\n       sum(mrr) as mrr,\n       count(*) as accounts\nfrom public.users\nwhere is_active\ngroup by 1\norder by 1 desc\nlimit 24;":JB[2]==='maintenance'?'vacuum (analyze, verbose) public.events;':"-- managed job: "+JB[2]):'';
  vals.jobOpts=[['Fail the run on zero rows','An empty report is usually a broken query, not good news.'],['Retry 3× with backoff','Then open an alert and page the on-call.'],['Skip if a previous run is still going','No overlapping runs on the same connection.'],['Attach the query text to the delivery','Recipients can see what produced the numbers.']].map((o,i)=>{const on=S.jobOpts[i];
   return{label:o[0],hint:o[1],onClick:()=>this.setState(s=>{const a=s.jobOpts.slice();a[i]=!a[i];return{jobOpts:a}}),
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  vals.newJob=()=>this.toast('New schedule','Pick a saved query, a cron expression and a destination. Comb validates the cron and shows the next five runs before saving.','info');
  // approvals
  const APPRS=[
   ['ap-118','UPDATE','orders · 412 rows','tom.r → you','pending','shop_staging'],
   ['ap-117','DROP','public.tmp_backfill','sam.d → you','pending','shop_local'],
   ['ap-116','GRANT','write on public.* to ci_deploy','maya.k → you','pending','analytics_prod'],
   ['ap-115','TRUNCATE','public.events · 48,201 rows','sam.d → maya.k','approved','shop_local'],
   ['ap-114','UPDATE','users · 1 row','ines.p → tom.r','rejected','shop_staging']
  ];
  vals.apprSegs=this.seg(['Waiting on me','All open','Decided'],S.apprFilter,l=>this.setState({apprFilter:l}));
  const apprF=APPRS.filter(a=>{const st=S.apprState[a[0]]||a[4];
   return S.apprFilter==='Decided'?st!=='pending':S.apprFilter==='All open'?st==='pending':st==='pending'&&a[3].indexOf('you')>0});
  vals.apprSummary=APPRS.filter(a=>(S.apprState[a[0]]||a[4])==='pending').length+' pending · median decision 6 min';
  vals.apprList=apprF.map(a=>{const st=S.apprState[a[0]]||a[4];
   return{kind:a[1],title:a[2],meta:a[5]+' · '+a[3],state:st.toUpperCase(),
    kindStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:kindColor(a[1]),whiteSpace:'nowrap'},
    stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',whiteSpace:'nowrap',color:st==='pending'?'var(--state-running)':st==='approved'?'var(--state-success)':'var(--state-error)'},
    barStyle:{width:2,height:11,flex:'none',background:this.idc(connOf(a[5]))},
    style:{display:'flex',flexDirection:'column',gap:5,padding:'8px 10px',cursor:'pointer',borderBottom:'1px solid var(--border-subtle)',background:S.apprSel===a[0]?'var(--bg-selected)':'transparent'},
    onClick:()=>this.setState({apprSel:a[0]})}});
  vals.apprEmpty=apprF.length===0;
  const AP=APPRS.find(a=>a[0]===S.apprSel&&apprF.indexOf(a)>=0)||apprF[0];
  vals.apprSel=!!AP;vals.apprNone=!AP;
  const apSt=AP?(S.apprState[AP[0]]||AP[4]):'pending';
  vals.appr=AP?{id:AP[0],kind:AP[1],summary:AP[1]+' on '+AP[2]+' · requested by '+AP[3].split(' → ')[0]+' on '+AP[5],
   kindStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',padding:'1px 5px',border:'1px solid '+kindColor(AP[1]),color:kindColor(AP[1]),whiteSpace:'nowrap'},
   sql:AP[1]==='UPDATE'?"begin;\nupdate public.orders\n   set status = 'shipped'\n where shipped_at is not null\n   and status = 'paid';\n-- 412 rows matched in the dry run\ncommit;":AP[1]==='DROP'?'drop table public.tmp_backfill;':'grant insert, update, delete on all tables in schema public to ci_deploy;'}:{id:'',kind:'',summary:'',sql:'',kindStyle:{}};
  vals.apprFacts=AP?[['Rows affected',AP[1]==='UPDATE'?'412':'0','num'],['Reversible',AP[1]==='DROP'?'no':'yes','text'],['Lock',AP[1]==='DROP'?'ACCESS EXCLUSIVE':'ROW EXCLUSIVE','text'],['Requested','18 min ago','text']].map(k=>({label:k[0],value:k[1],
   valueStyle:{fontFamily:k[2]==='num'?MONO:'inherit',fontSize:k[2]==='num'?18:13,lineHeight:'22px',fontWeight:500,color:k[1]==='no'?'var(--state-error)':'var(--text-primary)'}})):[];
  vals.apprWarn=!!(AP&&(AP[1]==='DROP'||AP[1]==='GRANT'));
  vals.apprWarnTitle=AP&&AP[1]==='DROP'?'No down path':'Widens a service identity';
  vals.apprWarnBody=AP&&AP[1]==='DROP'?'There is no backup of public.tmp_backfill in the last 24 h. Approving this destroys 2.1 MB permanently.':'ci_deploy would gain write access to every table in public, including tables added later. A per-table grant is narrower.';
  vals.apprDry=AP?[['✓','Parsed and planned against a branch of the live catalog.'],['✓','412 rows matched — the same count the author saw.'],[AP[1]==='DROP'?'✕':'✓',AP[1]==='DROP'?'No compensating statement can be generated for a DROP.':'Compensating UPDATE generated and stored with the request.'],['⚠','Runs during business hours. Estimated lock time 1.2 s.']].map((d,i)=>({icon:d[0],text:d[1],
   iconStyle:{width:12,flex:'none',fontSize:11,color:d[0]==='✓'?'var(--state-success)':d[0]==='✕'?'var(--state-error)':'var(--state-running)'},
   style:{display:'flex',alignItems:'flex-start',gap:9,padding:'7px 10px',borderTop:i?'1px solid var(--border-subtle)':'none'}})):[];
  vals.apprThread=(S.apprNotes[AP?AP[0]:'']||[]).concat(AP?[{who:AP[3].split(' → ')[0],text:AP[1]==='UPDATE'?'Fulfilment sent the wrong status for yesterday\u2019s batch. This realigns them; I checked the 412 ids against the carrier export.':'Left over from the org_id backfill. Nothing reads it.',when:'18 min ago'}]:[]).reverse();
  vals.apprNote=S.apprNoteDraft;vals.onApprNote=e=>this.setState({apprNoteDraft:e.target.value});
  vals.addApprNote=()=>{const v=S.apprNoteDraft.trim();if(!v||!AP)return;
   this.setState(s=>({apprNotes:Object.assign({},s.apprNotes,{[AP[0]]:(s.apprNotes[AP[0]]||[]).concat([{who:'you',text:v,when:'just now'}])}),apprNoteDraft:''}))};
  vals.apprBtnLabel=apSt==='pending'?'Approve':apSt.charAt(0).toUpperCase()+apSt.slice(1);
  vals.apprBtnStyle={height:26,padding:'0 13px',borderRadius:3,fontSize:12,fontWeight:500,whiteSpace:'nowrap',
   background:apSt==='pending'?'var(--btn-primary)':'var(--bg-hover)',color:apSt==='pending'?'var(--text-inverse)':'var(--text-muted)',cursor:apSt==='pending'?'pointer':'default'};
  vals.apprApprove=()=>{if(!AP||apSt!=='pending')return;
   this.setState(s=>({apprState:Object.assign({},s.apprState,{[AP[0]]:'approved'})}));
   this.toast('Approved '+AP[0],'The author can now run it once, on '+AP[5]+', within 30 minutes. Then it expires.','success')};
  vals.apprReject=()=>{if(!AP||apSt!=='pending')return;
   this.setState(s=>({apprState:Object.assign({},s.apprState,{[AP[0]]:'rejected'})}));
   this.toast('Rejected '+AP[0],'Add a note so they know what to change.','error')};
  // data catalog & governance
  vals.isCatalogTab=kind==='catalog';vals.isBackupTab=kind==='backup';
  const CAT=[
   ['users.email','text','PII','partial','data-platform','login identity, unique','12 queries · 3 views'],
   ['users.password_hash','text','SECRET','full','security','scram-sha-256 digest','0 queries'],
   ['users.mrr','numeric','FINANCIAL','none','finance','monthly recurring revenue, USD','41 queries · 2 reports'],
   ['users.org_id','uuid','INTERNAL','none','data-platform','tenant boundary — RLS key','88 queries'],
   ['users.metadata','jsonb','UNCLASSIFIED','none','—','free-form, unaudited','4 queries'],
   ['customers.name','text','PII','partial','data-platform','legal name as supplied','9 queries'],
   ['customers.dob','date','PII','full','security','date of birth — GDPR special category','1 query'],
   ['orders.status','text','INTERNAL','none','fulfilment','paid | shipped | refunded','120 queries'],
   ['orders.total','numeric','FINANCIAL','none','finance','gross, minor units','61 queries · 4 reports'],
   ['invoices.card_last4','text','PII','full','security','last four digits only, never full PAN','2 queries'],
   ['events.payload','jsonb','UNCLASSIFIED','none','—','unbounded — the PII scanner flags this weekly','18 queries'],
   ['sessions.ip','inet','PII','partial','security','source address, 90-day retention','6 queries']
  ];
  const klassColor=k=>({PII:'var(--type-identifier)',SECRET:'var(--danger)',FINANCIAL:'var(--type-structured)',INTERNAL:'var(--state-info)',UNCLASSIFIED:'var(--text-muted)'}[k]);
  const KL=['UNCLASSIFIED','INTERNAL','FINANCIAL','PII','SECRET'],MK=['none','partial','full'];
  vals.catSegs=this.seg(['All','PII','Secret','Unclassified'],S.catFilter,l=>this.setState({catFilter:l}));
  const cq=S.catQ.toLowerCase();
  const catF=CAT.filter(c=>{const kl=S.catKlass[c[0]]||c[2];
   return (S.catFilter==='All'||(S.catFilter==='PII'?kl==='PII':S.catFilter==='Secret'?kl==='SECRET':kl==='UNCLASSIFIED'))
    &&(!cq||(c[0]+c[2]+c[4]+c[5]).toLowerCase().indexOf(cq)>=0)});
  vals.catQ=S.catQ;vals.onCatQ=e=>this.setState({catQ:e.target.value});
  vals.catSummary=catF.length+' of 318 columns · 6 PII · 2 secret · 2 unclassified';
  const catT='210px 84px 132px 104px 124px minmax(160px,1fr) 150px';
  vals.catHeadStyle={display:'grid',gridTemplateColumns:catT,minWidth:940,position:'sticky',top:0,zIndex:2,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  const famOf=t=>t==='numeric'?'numeric':t==='jsonb'?'structured':t==='uuid'||t==='inet'?'identifier':t==='date'?'temporal':'text';
  vals.catRows=catF.map(c=>{const kl=S.catKlass[c[0]]||c[2],mk=S.catMask[c[0]]||c[3];
   return{name:c[0],type:c[1],klass:kl,mask:mk,owner:c[4],desc:c[5],usage:c[6],
    tickStyle:{width:2,height:13,flex:'none',background:TYPEC[famOf(c[1])]},
    classStyle:{height:20,padding:'0 6px',border:'1px solid '+klassColor(kl),borderRadius:3,fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:klassColor(kl),whiteSpace:'nowrap'},
    maskStyle:{height:20,padding:'0 6px',border:'1px solid '+(mk==='none'?'var(--border-subtle)':'var(--border-strong)'),borderRadius:3,fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',whiteSpace:'nowrap',
     color:mk==='full'?'var(--state-success)':mk==='partial'?'var(--state-running)':'var(--text-muted)'},
    style:{display:'grid',gridTemplateColumns:catT,minWidth:940,height:rh,borderBottom:'1px solid var(--border-subtle)',cursor:'pointer',background:S.catSel===c[0]?'var(--bg-selected)':'transparent'},
    onClick:()=>this.setState({catSel:c[0]}),
    onClass:e=>{e.stopPropagation();const nx=KL[(KL.indexOf(kl)+1)%KL.length];
     this.setState(s=>({catKlass:Object.assign({},s.catKlass,{[c[0]]:nx})}));
     this.toast(c[0]+' → '+nx,nx==='SECRET'?'Now excluded from AI context and from every export by default.':'Classification recorded in the catalog and in the trail.','info')},
    onMask:e=>{e.stopPropagation();const nx=MK[(MK.indexOf(mk)+1)%MK.length];
     this.setState(s=>({catMask:Object.assign({},s.catMask,{[c[0]]:nx})}));
     this.toast('Masking: '+nx,nx==='none'?'Raw values visible to anyone with read access.':nx==='partial'?"Shown as a•••@acme.com to roles without unmask.":"Shown as '***' to roles without unmask.",'info')}}});
  vals.catEmpty=catF.length===0;
  const CS=CAT.find(c=>c[0]===S.catSel)||CAT[0];
  vals.catSel=!!CS;vals.cat={name:CS[0]};vals.closeCat=()=>this.setState({catSel:null});
  vals.catStats=[['distinct','48,201'],['null','0.4%'],['avg length','21'],['max length','64']].map(s=>({label:s[0],value:s[1]}));
  vals.catHist=[3,7,12,18,14,9,6,4,3,2,2,1,1,1].map((v,i)=>({title:'bucket '+(i+1)+' · '+v+'%',style:{flex:1,height:Math.round(v*1.6)+'px',background:'var(--border-strong)'}}));
  vals.catLineage=[['←','stripe_sync.customers','source'],['·','public.'+CS[0].split('.')[0],'this table'],['→','analytics.dim_users','view'],['→','MRR weekly report','scheduled job']].map((l,i)=>({arrow:l[0],name:l[1],kind:l[2],
   arrowStyle:{width:10,flex:'none',fontFamily:MONO,fontSize:12,color:l[0]==='·'?'var(--text-primary)':'var(--text-muted)'},
   style:{display:'flex',alignItems:'center',gap:8,padding:'0 9px',height:24,border:'1px solid '+(l[0]==='·'?'var(--border-strong)':'var(--border-subtle)'),borderRadius:3,background:l[0]==='·'?'var(--bg-base)':'transparent'}}));
  vals.catAccess=[['maya.k',88,'412'],['svc_export',54,'251'],['tom.r',22,'104']].map(a=>({who:a[0],n:a[2],
   fillStyle:{display:'block',height:'100%',width:a[1]+'%',background:'var(--state-info)'}}));
  vals.catRetention=(S.catKlass[CS[0]]||CS[2])==='PII'?'PII columns inherit a 90-day retention policy. A nightly job nulls rows older than that in sessions and events; users and customers are exempt while the account is active.':'No retention policy on this classification. Rows live until something deletes them.';
  vals.rescan=()=>this.toast('PII scan queued','Samples 10k rows per table, matches 24 patterns and column names. Values never leave the server. Last scan found 2 new candidates in events.payload.','info');
  // backups & recovery
  vals.backupKpis=[['4 min','RPO','worst case data loss','ok'],['18 min','RTO','last verified restore drill','ok'],['9 days','PITR window','WAL retained to 2026-08-05','ok'],['✓','Restore verified','nightly drill · 06:12 today','ok']].map(k=>({label:k[1],value:k[0],note:k[2],
   valueStyle:{fontFamily:MONO,fontSize:22,lineHeight:'28px',fontWeight:500,color:k[3]==='ok'?'var(--text-primary)':'var(--state-running)'},
   style:{display:'flex',flexDirection:'column',gap:4,padding:'10px 11px',border:'1px solid var(--border-subtle)',borderLeft:'3px solid var(--state-success)',borderRadius:3,background:'var(--bg-raised)'}}));
  const pp=S.pitr;
  vals.pitrPos=pp;vals.onPitr=e=>this.setState({pitr:Number(e.target.value)});
  vals.pitrFillStyle={position:'absolute',left:0,top:14,height:6,width:pp+'%',background:'var(--state-info)',borderRadius:3};
  vals.pitrHandleStyle={position:'absolute',left:'calc('+pp+'% - 1px)',top:6,width:2,height:22,background:'var(--text-primary)'};
  vals.pitrMarks=[[4,'base backup 08-05 02:00'],[26,'base backup 08-08 02:00'],[52,'base backup 08-11 02:00'],[78,'base backup 08-13 02:00'],[97,'base backup 08-14 02:00']].map(m=>({title:m[1],
   style:{position:'absolute',left:m[0]+'%',top:10,width:6,height:14,marginLeft:-3,background:'var(--border-strong)',border:'1px solid var(--bg-base)'}}));
  const mins=Math.round((100-pp)*129.6);
  const d=new Date(Date.UTC(2026,7,14,11,56)-mins*60000);
  const pad=n=>(n<10?'0':'')+n;
  vals.pitrTime=d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())+' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+' UTC';
  vals.pitrNote=pp>96?'inside the last base backup — replay is seconds':pp>50?'replays '+Math.round(mins/60)+' h of WAL · est. 6 min':'replays '+Math.round(mins/1440)+' days of WAL · est. '+(12+Math.round((100-pp)/4))+' min';
  const bkT='140px 96px 92px 96px 130px minmax(180px,1fr)';
  vals.bkHeadStyle={display:'grid',gridTemplateColumns:bkT,minWidth:760,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.backupRows=[['08-14 02:00','BASE','12.4 GB','8 m 12 s','ok','s3://acme-backups/analytics/base/…'],['08-13 02:00','BASE','12.2 GB','7 m 58 s','ok','s3://acme-backups/analytics/base/…'],['08-12 02:00','BASE','12.1 GB','8 m 41 s','ok','s3://acme-backups/analytics/base/…'],['08-11 02:00','BASE','12.0 GB','9 m 02 s','warn','s3://acme-backups/analytics/base/…'],['continuous','WAL','412 MB/h','—','ok','s3://acme-backups/analytics/wal/'],['08-07 02:00','BASE','11.6 GB','7 m 44 s','ok','glacier://acme-backups/…']].map((b,i)=>({when:b[0],kind:b[1],size:b[2],dur:b[3],verified:b[4]==='ok'?'✓ restored':'⚠ not drilled',dest:b[5],
   style:{display:'grid',gridTemplateColumns:bkT,minWidth:760,height:rh,borderBottom:i<5?'1px solid var(--border-subtle)':'none'},
   cell:{display:'flex',alignItems:'center',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12},
   numCell:{display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,color:'var(--text-secondary)'},
   kindStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:b[1]==='WAL'?'var(--state-info)':'var(--text-secondary)'},
   vStyle:{fontFamily:MONO,fontSize:12,whiteSpace:'nowrap',color:b[4]==='ok'?'var(--state-success)':'var(--state-running)'}}));
  vals.backupNow=()=>this.toast('Base backup started','pg_basebackup from replica-2, so the primary keeps serving. ETA 8 minutes.','info');
  vals.restorePreview=()=>this.toast('Scratch restore queued',vals.pitrTime+' → comb_scratch_4f81. It appears in your launcher when it is ready, tagged LOCAL and read-only.','success');
  vals.restoreInPlace=()=>this.setState({confirm:{kind:'RESTORE',table:C.name,input:''}});
  // query library
  vals.isLibraryTab=kind==='library';vals.isSecurityTab=kind==='security';vals.isIntegrationsTab=kind==='integrations';
  const LIB=[
   ['q1','MRR by month','Finance/Revenue','maya.k','ran 412×',true,'monthly recurring revenue split by plan tier, 24 months back',2],
   ['q2','Churn cohort','Finance/Revenue','maya.k','ran 188×',true,'accounts that stopped paying, grouped by signup month',1],
   ['q3','Stuck orders','Ops','tom.r','ran 1.2k×',true,'orders paid over 48 h ago with no shipment row',0],
   ['q4','Schema sizes','Ops','tom.r','ran 96×',false,'table and index bytes for the ten largest relations',0],
   ['q5','Duplicate emails','Data quality','sam.d','ran 41×',false,'users sharing an email after case folding',0],
   ['q6','Refund rate by region','Finance/Revenue','ines.p','ran 22×',true,'refunded over settled, by billing country',1],
   ['q7','Index candidates','Ops','maya.k','ran 8×',false,'sequential scans on tables over 100k rows',0],
   ['q8','PII inventory','Compliance','maya.k','ran 12×',true,'every column classified PII or SECRET with its owner',0]
  ];
  vals.libSegs=this.seg(['All','Mine','Shared'],S.libFilter,l=>this.setState({libFilter:l}));
  const lq=S.libQ.toLowerCase();
  const libF=LIB.filter(q=>(S.libFilter==='All'||(S.libFilter==='Mine'?q[3]==='maya.k':q[5]))&&(!lq||(q[1]+q[2]+q[6]).toLowerCase().indexOf(lq)>=0));
  vals.libQ=S.libQ;vals.onLibQ=e=>this.setState({libQ:e.target.value});
  vals.libSummary=libF.length+' queries · 4 folders · 5 shared';
  vals.libList=libF.map(q=>({name:q[1],meta:q[2]+' · '+q[3]+' · '+q[4],shared:q[5],icon:'⌗',
   iconStyle:{color:'var(--text-muted)',fontSize:11,width:11,flex:'none'},
   style:{display:'flex',flexDirection:'column',gap:4,padding:'8px 10px',cursor:'pointer',borderBottom:'1px solid var(--border-subtle)',background:S.libSel===q[0]?'var(--bg-selected)':'transparent'},
   onClick:()=>this.setState({libSel:q[0]})}));
  vals.libEmpty=libF.length===0;
  const LQ=LIB.find(q=>q[0]===S.libSel)||libF[0]||LIB[0];
  vals.lib={name:LQ[1],desc:LQ[6]};
  vals.libHasParams=LQ[7]>0;
  vals.libParams=[['months','24'],['plan_tier','pro']].slice(0,LQ[7]).map(p=>({name:':'+p[0],value:S.libParamVals[p[0]]!==undefined?S.libParamVals[p[0]]:p[1],
   onChange:e=>this.setState(s=>({libParamVals:Object.assign({},s.libParamVals,{[p[0]]:e.target.value})}))}));
  const LIBSQL={q1:["select date_trunc('month', created_at) as month,","       plan,","       sum(mrr) as mrr,","       count(*) as accounts","from public.users","where is_active","  and created_at >= now() - (:months || ' months')::interval","group by 1, 2","order by 1 desc, 3 desc;"],
   q3:["select o.id, o.user_id, o.created_at, o.status","from public.orders o","left join public.shipments s on s.order_id = o.id","where o.status = 'paid'","  and s.id is null","  and o.created_at < now() - interval '48 hours'","order by o.created_at;"]};
  vals.libLines=(LIBSQL[LQ[0]]||['select 1;']).map((l,i)=>({n:i+1,text:l,
   style:{fontFamily:MONO,fontSize:12,lineHeight:'19px',whiteSpace:'pre',color:/^(select|from|where|group|order|left|join|and)/.test(l.trim())?'var(--text-primary)':'var(--text-secondary)'}}));
  vals.libVersions=[['v4','bound :months instead of a literal','maya.k'],['v3','excluded cancelled accounts','maya.k'],['v2','split by plan tier','tom.r'],['v1','first version','maya.k']].map((v,i)=>({n:v[0],note:v[1],who:v[2],
   style:{display:'flex',alignItems:'center',gap:9,padding:'0 10px',height:rh-6,borderTop:i?'1px solid var(--border-subtle)':'none',background:i===0?'var(--bg-base)':'transparent'},
   onDiff:()=>this.toast('Diff '+v[0]+' → v4','2 lines changed, 1 added. Versions are immutable — restoring one creates v5.','info')}));
  vals.libShare=[['Shared with the workspace','Anyone with access to the connection can run it.'],['Allow scheduling','Others can attach a schedule without copying it.'],['Lock the SQL','Only the owner can edit; others fork.']].map((s,i)=>{const on=S.libShareOpts[i];
   return{label:s[0],hint:s[1],onClick:()=>this.setState(st=>{const a=st.libShareOpts.slice();a[i]=!a[i];return{libShareOpts:a}}),
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  vals.libRunStats=LQ[4]+' · median 240 ms · last run 2 h ago by svc_export';
  vals.libOpen=()=>{this.newQueryTab();this.toast('Opened '+LQ[1],'Parameters carried over. Nothing ran yet.','info')};
  vals.libSchedule=()=>{this.openKind('jobs','Jobs');this.toast('Pick a cadence','Comb validates the cron and previews the next five runs before it saves.','info')};
  vals.newSaved=()=>this.toast('Saved to the library','Named from the first comment in the editor. Private until you share it.','success');
  // security
  vals.sessionRows=[['This device · macOS · Comb 1.4.2','10.2.7.44 · San Francisco · SAML','now',true],['iPad · Safari','10.2.7.51 · San Francisco · SAML','4 h ago',false],['Linux · Comb 1.3.9','198.51.100.22 · Berlin · password','2 d ago',false],['CI runner · token svc_export','10.4.1.19 · token auth','11:40',false]].map((s,i)=>({device:s[0],meta:s[1],seen:s[2],
   dotStyle:{width:6,height:6,borderRadius:'50%',flex:'none',background:s[3]?'var(--state-success)':'var(--text-muted)'},
   style:{display:'flex',alignItems:'center',gap:10,padding:'0 10px',height:rh+8,borderTop:i?'1px solid var(--border-subtle)':'none',background:s[1].indexOf('password')>0?'color-mix(in oklab, var(--state-running) 8%, transparent)':'transparent'},
   btnLabel:s[3]?'current':'revoke',
   btnStyle:{fontSize:11,whiteSpace:'nowrap',color:s[3]?'var(--text-muted)':'var(--text-secondary)',cursor:s[3]?'default':'pointer'},
   onRevoke:()=>s[3]?null:this.toast('Session revoked','That device is signed out within a minute.','error')}));
  vals.revokeAll=()=>this.toast('3 sessions revoked','Every device except this one is signed out. Tokens are unaffected — revoke those separately.','error');
  const tokT='168px 110px minmax(160px,1fr) 118px 150px';
  vals.tokHeadStyle={display:'grid',gridTemplateColumns:tokT,minWidth:760,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.tokenRows=[['svc_export','cmb_live_9f2…',['read','export'],'11:40 today','2026-12-31','ok'],['ci_deploy','cmb_live_4a1…',['migrate'],'13:58 today','2026-09-30','soon'],['grafana_metrics','cmb_live_77c…',['read'],'2 min ago','never','warn'],['old_laptop_cli','cmb_live_1bb…',['read','write'],'94 days ago','2026-08-20','soon']].map((t,i)=>({name:t[0],prefix:t[1],used:t[3],expires:t[4],
   style:{display:'grid',gridTemplateColumns:tokT,minWidth:760,height:rh+4,borderBottom:i<3?'1px solid var(--border-subtle)':'none',background:t[3].indexOf('94 days')===0?'color-mix(in oklab, var(--state-running) 8%, transparent)':'transparent'},
   scopes:t[2].map(sc=>({label:sc,style:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',padding:'0 5px',border:'1px solid var(--border-strong)',borderRadius:3,whiteSpace:'nowrap',
    color:sc==='write'||sc==='migrate'?'var(--state-running)':'var(--text-secondary)'}})),
   expStyle:{fontFamily:MONO,fontSize:12,whiteSpace:'nowrap',color:t[5]==='warn'?'var(--state-error)':t[5]==='soon'?'var(--state-running)':'var(--text-secondary)'},
   onRevoke:()=>this.toast('Revoked '+t[0],'Any request with that token now gets 401. This cannot be undone.','error')}));
  vals.newToken=()=>this.toast('Token created once','Copy it now — Comb stores only a hash and will never show it again.','success');
  vals.ipRows=S.ips.map(i=>({cidr:i[0],note:i[1],onRemove:()=>this.setState(s=>({ips:s.ips.filter(x=>x[0]!==i[0])}))}));
  vals.newIp=S.newIp;vals.onNewIp=e=>this.setState({newIp:e.target.value});
  const addIp=()=>{const v=S.newIp.trim();if(!v)return;this.setState(s=>({ips:s.ips.concat([[v,'added just now']]),newIp:''}))};
  vals.addIp=addIp;vals.onNewIpKey=e=>{if(e.key==='Enter'){e.preventDefault();addIp()}};
  vals.ipWarn=S.ips.length?'Requests from outside these ranges are refused before authentication. Your current address is inside 10.2.0.0/16.':'Empty allowlist means every address is allowed. That is the default, and it is the weakest setting on this page.';
  vals.ipWarnStyle={fontSize:12,lineHeight:'17px',color:S.ips.length?'var(--text-muted)':'var(--state-running)'};
  vals.secPolicies=[['Require MFA for every member','Including owners and service accounts with interactive login.'],['Block password auth','SAML only.'],['Require approval for prod writes','A second person, who did not author the statement.'],['Forbid SELECT * on classified tables','Columns must be named when PII is present.'],['Watermark exports','Every CSV carries who exported it and when.']].map((p,i)=>{const on=S.secPol[i];
   return{label:p[0],hint:p[1],onClick:()=>this.setState(s=>{const a=s.secPol.slice();a[i]=!a[i];return{secPol:a}}),
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  vals.idleSegs=this.seg(['15m','1h','8h','off'],S.idle,l=>this.setState({idle:l}));
  vals.idleNote=S.idle==='off'?'Sessions never expire on their own — only on revoke.':'Applies to the workspace UI, not to open database connections.';
  // integrations
  const INTEG=[
   ['Slack','#ops-alerts','Job failures, deadlocks and approval requests as messages you can act on.','2 min ago'],
   ['PagerDuty','service COMB-DB','Only critical monitor alerts page. Warnings stay in Comb.','no incidents'],
   ['S3','s3://acme-warehouse/comb/','Scheduled exports land as partitioned Parquet with a manifest.','02:00 today'],
   ['dbt Cloud','acme/analytics','Comb reads the manifest so lineage in the catalog matches your models.','synced 06:00'],
   ['Datadog','comb.* metrics','Query latency, connection counts and job outcomes as metrics.','streaming'],
   ['Webhook','https://hooks.acme.internal/comb','Signed JSON for anything the others do not cover.','412 delivered']
  ];
  vals.integrations=INTEG.map((i,idx)=>{const on=S.integ[idx];
   return{name:i[0],target:i[1],desc:i[2],last:i[3],mark:i[0].slice(0,2).toUpperCase(),state:on?'CONNECTED':'OFF',
    markStyle:{width:26,height:26,flex:'none',display:'grid',placeItems:'center',borderRadius:3,border:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.04em',color:on?'var(--text-primary)':'var(--text-muted)',background:on?'var(--bg-base)':'transparent'},
    stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',color:on?'var(--state-success)':'var(--text-muted)'},
    style:{display:'flex',flexDirection:'column',gap:8,padding:'11px 12px',border:'1px solid var(--border-subtle)',borderRadius:3,background:'var(--bg-raised)',opacity:on?1:.66},
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'},
    onToggle:()=>this.setState(s=>{const a=s.integ.slice();a[idx]=!a[idx];return{integ:a}}),
    onTest:()=>this.toast('Test event sent to '+i[0],on?'Delivered in 210 ms. Check '+i[1]+'.':'Integration is off — nothing was sent.',on?'success':'error')}});
  const evT='minmax(180px,1fr) repeat(4, 92px)';
  vals.evCols=['Slack','PagerDuty','Webhook','Email'];
  vals.evHeadStyle={display:'grid',gridTemplateColumns:evT,minWidth:620,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  const EVENTS=['job.failed','job.succeeded','query.blocked','approval.requested','migration.applied','monitor.critical'];
  vals.evRows=EVENTS.map((ev,i)=>({event:ev,
   style:{display:'grid',gridTemplateColumns:evT,minWidth:620,height:rh-4,borderTop:i?'1px solid var(--border-subtle)':'none'},
   cells:vals.evCols.map((ch,j)=>{const key=ev+':'+ch;
    const base=(ev==='job.failed'&&j<3)||(ev==='monitor.critical'&&j<2)||(ev==='approval.requested'&&(j===0||j===3))||(ev==='query.blocked'&&j===0)||(ev==='migration.applied'&&j===2);
    const on=S.evSub[key]!==undefined?S.evSub[key]:base;
    return{mark:on?'●':'·',
     markStyle:{fontSize:on?9:12,color:on?(S.evSub[key]!==undefined?'var(--state-running)':'var(--state-success)'):'var(--text-muted)'},
     style:{display:'flex',alignItems:'center',justifyContent:'center',borderRight:'1px solid var(--border-subtle)',cursor:'pointer'},
     onClick:()=>this.setState(s=>{const g=Object.assign({},s.evSub);if(g[key]!==undefined)delete g[key];else g[key]=!base;return{evSub:g}})}})}));
  // compliance
  vals.isComplianceTab=kind==='compliance';vals.isUsageTab=kind==='usage';vals.isTopologyTab=kind==='topology';
  const CTRLS=[
   ['Every production write is attributable','SOC 2 CC7.2','audit trail · 8,841 events','continuous','pass',false],
   ['Privileged access reviewed quarterly','SOC 2 CC6.3','roles page · last review 07-02','43 days ago','pass',false],
   ['MFA enforced for all human members','SOC 2 CC6.1','1 member on password auth','continuous','fail',true],
   ['Backups verified by restore','SOC 2 A1.2','nightly drill · 06:12 today','today','pass',false],
   ['PII inventory complete','GDPR Art. 30','2 columns unclassified in events','continuous','warn',true],
   ['Retention enforced on personal data','GDPR Art. 5(1)(e)','nightly job · 90 days','today','pass',false],
   ['Encryption in transit and at rest','SOC 2 CC6.7','TLS 1.3 · AES-256 volumes','continuous','pass',false]
  ];
  const ctrlT='minmax(230px,1fr) 138px minmax(180px,1fr) 116px 130px';
  vals.ctrlHeadStyle={display:'grid',gridTemplateColumns:ctrlT,minWidth:820,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.controlRows=CTRLS.map((c,i)=>({name:c[0],fw:c[1],evidence:c[2],when:c[3],state:c[4]==='pass'?'✓ pass':c[4]==='warn'?'⚠ gap':'✕ fail',fixable:c[5],
   style:{display:'grid',gridTemplateColumns:ctrlT,minWidth:820,height:rh,borderBottom:i<CTRLS.length-1?'1px solid var(--border-subtle)':'none',
    background:c[4]==='fail'?'color-mix(in oklab, var(--state-error) 8%, transparent)':c[4]==='warn'?'color-mix(in oklab, var(--state-running) 7%, transparent)':'transparent'},
   stateStyle:{fontFamily:MONO,fontSize:12,whiteSpace:'nowrap',color:c[4]==='pass'?'var(--state-success)':c[4]==='warn'?'var(--state-running)':'var(--state-error)'},
   onFix:()=>c[0].indexOf('MFA')>=0?(this.openKind('security','Security'),this.toast('Open the policy list','Turn on “Block password auth” to close this control.','info'))
    :(this.openKind('catalog','Data catalog'),this.toast('Two columns to classify','events.payload and users.metadata are unclassified.','info'))}));
  vals.exportEvidence=()=>this.toast('Evidence pack building','Control states, the audit trail for the period, access reviews and restore-drill results as one signed archive. Usually 30 seconds.','info');
  const DSRS=[
   ['d1','ERASURE','maya.customer@gmail.com','users, customers, sessions, events','due in 12 days','open'],
   ['d2','ACCESS','ravi@personal.com','all tables carrying PII','due in 3 days','open'],
   ['d3','ERASURE','old.account@yahoo.com','users, customers, sessions','completed 08-02','done'],
   ['d4','RECTIFY','tom@personal.com','customers.name','due in 21 days','open']
  ];
  vals.dsrSummary=DSRS.filter(d=>(S.dsrState[d[0]]||d[5])==='open').length+' open · 30-day statutory clock';
  vals.dsrRows=DSRS.map((d,i)=>{const st=S.dsrState[d[0]]||d[5];
   return{kind:d[1],subject:d[2],scope:d[3],due:st==='done'?d[4]:d[4],state:st==='done'?'DONE':'OPEN',
    kindStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',width:74,flex:'none',color:d[1]==='ERASURE'?'var(--danger)':d[1]==='ACCESS'?'var(--state-info)':'var(--state-running)'},
    dueStyle:{fontFamily:MONO,fontSize:12,whiteSpace:'nowrap',color:d[4].indexOf('3 days')>0?'var(--state-running)':'var(--text-secondary)'},
    stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',width:52,flex:'none',color:st==='done'?'var(--state-success)':'var(--state-running)'},
    style:{display:'flex',alignItems:'center',gap:10,padding:'0 10px',height:rh+6,borderTop:i?'1px solid var(--border-subtle)':'none',cursor:'pointer',background:S.dsrSel===d[0]?'var(--bg-selected)':'transparent'},
    btnLabel:st==='done'?'report':'build plan',
    btnStyle:{height:22,padding:'0 8px',border:'1px solid var(--border-strong)',borderRadius:3,fontSize:11,whiteSpace:'nowrap'},
    onClick:()=>this.setState({dsrSel:d[0]}),
    onRun:e=>{e.stopPropagation();if(st==='done')return this.toast('Report regenerated','Signed PDF listing every table touched and the row counts.','info');
     this.setState(s=>({dsrState:Object.assign({},s.dsrState,{[d[0]]:'done'})}));
     this.toast(d[1]+' plan executed','7 statements in one transaction across 4 tables. Recorded in the trail with the request id.','success')}}});
  const DS=DSRS.find(d=>d[0]===S.dsrSel)||DSRS[0];
  vals.dsrSel=!!DS;
  vals.dsr={subject:DS[2],plan:DS[1]==='ERASURE'?"-- 1. users            → anonymise email, null metadata      (1 row)\n-- 2. customers        → null name, dob                      (1 row)\n-- 3. sessions         → delete                               (214 rows)\n-- 4. events           → redact payload.email                 (1,882 rows)\n-- 5. invoices         → keep (legal basis: tax retention, 7 y)\n-- 6. audit trail      → keep (the record of the erasure itself)\n\n-- orders.user_id keeps its foreign key: the order history stays,\n-- the person behind it does not."
   :"-- every column classified PII where this subject appears:\n-- users.email, users.metadata, customers.name, customers.dob,\n-- sessions.ip (214 rows), events.payload (1,882 rows)\n-- output: one JSON document per table, machine-readable, signed."};
  vals.newDsr=()=>this.toast('New request','Give Comb an identifier — an email, a customer id, a uuid. It walks the catalog to find every column that could hold it.','info');
  vals.retentionRows=[['sessions','90 days','enforced'],['events','13 months','enforced'],['audit trail','400 days','enforced'],['users (inactive)','7 years','manual']].map((r,i)=>({target:r[0],keep:r[1],state:r[2].toUpperCase(),
   stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',whiteSpace:'nowrap',width:74,textAlign:'right',color:r[2]==='enforced'?'var(--state-success)':'var(--state-running)'},
   style:{display:'flex',alignItems:'center',gap:10,padding:'0 10px',height:rh-4,borderTop:i?'1px solid var(--border-subtle)':'none'}}));
  vals.residencyRows=[['Data','eu-central-1 · Frankfurt'],['Backups','eu-central-1 + eu-west-1'],['Comb server','self-hosted, your VPC'],['Sub-processors',S.apiKey?'1 — model provider (AI panel)':'none']].map(r=>({label:r[0],value:r[1]}));
  // usage & cost
  vals.usageSegs=this.seg(['This month','Last month','90 days'],S.usageRange,l=>this.setState({usageRange:l}));
  vals.usageSummary='$4,182 attributed · 612 compute hours · 41 members';
  vals.usageKpis=[['$4,182','+8%','Attributed spend','up'],['612 h','+3%','Compute time','up'],['1.9M','+21%','Statements','up'],['$0.0022','−12%','Cost per statement','down']].map(k=>({value:k[0],delta:k[1],label:k[2],
   deltaStyle:{fontFamily:MONO,fontSize:11,color:k[3]==='down'?'var(--state-success)':'var(--state-running)'}}));
  const TEAMS=[['Data platform',214,[52,31,17],'$1,462'],['Finance',162,[71,12,17],'$1,108'],['Ops',121,[44,38,18],'$824'],['Growth',78,[62,20,18],'$533'],['Scheduled jobs',37,[8,4,88],'$255']];
  const SEGC=['var(--state-info)','var(--type-temporal)','var(--type-structured)'];
  vals.teamUsage=TEAMS.map(t=>({team:t[0],hours:t[1]+' h',cost:t[3],
   segs:t[2].map((v,i)=>({title:['ad-hoc queries','dashboards','scheduled'][i]+' '+v+'%',style:{width:(v*t[1]/214)+'%',background:SEGC[i],height:'100%',display:'block'}}))}));
  vals.usageLegend=['ad-hoc queries','dashboards','scheduled jobs'].map((l,i)=>({label:l,style:{width:9,height:9,background:SEGC[i],flex:'none'}}));
  vals.costRows=[['MRR weekly report','svc_export','$212'],['select … order_items join','tom.r','$188'],['Churn cohort refresh','svc_export','$141'],['Nightly full export','svc_export','$126'],['ad-hoc select * from events','sam.d','$98']].map((c,i)=>({name:c[0],who:c[1],cost:c[2],
   style:{display:'flex',alignItems:'center',gap:10,padding:'0 10px',height:rh-4,borderTop:i?'1px solid var(--border-subtle)':'none'}}));
  vals.savings=[['⚡','Drop users_metadata_gin','0 scans in 30 days, 412 MB, and it slows every insert on the table.','$41/mo'],['⚡','Route the MRR report at a replica','It runs at 07:00 against the primary while the day starts.','$96/mo'],['⚡','Add the shipped_at index','The fulfilment query does a sequential scan 18k times a month.','$212/mo']].map(s=>({mark:s[0],title:s[1],body:s[2],saving:s[3],
   markStyle:{fontSize:11,color:'var(--state-running)',width:12,flex:'none',paddingTop:3}}));
  vals.exportUsage=()=>this.toast('Chargeback export queued','Per-team compute hours and attributed cost, plus the query-level detail behind each line.','info');
  // topology
  vals.topoSummary='1 primary · 2 replicas · sync quorum 1 · eu-central-1';
  const NODES=[
   ['PRIMARY','db-1.internal','eu-central-1a','16.3','ok',[['load','62 / 200 conn'],['wal','412 MB/h'],['disk','61% of 2 TB'],['uptime','41 d']],7],
   ['SYNC REPLICA','db-2.internal','eu-central-1b','16.3','ok',[['write lag','12 ms'],['apply lag','0.2 s'],['disk','61% of 2 TB'],['reads','38% routed']],9],
   ['ASYNC REPLICA','db-3.internal','eu-west-1a','16.3','warn',[['write lag','840 ms'],['apply lag','1.8 s'],['disk','58% of 2 TB'],['reads','12% routed']],11],
   ['PITR ARCHIVE','s3 · wal-g','eu-central-1 + eu-west-1','—','ok',[['window','9 days'],['last wal','4 min ago'],['size','1.9 TB'],['verified','06:12 today']],13]
  ];
  vals.nodes=NODES.map(n=>({role:n[0],host:n[1],region:n[2],version:n[3],
   roleStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',padding:'1px 5px',whiteSpace:'nowrap',
    background:n[0]==='PRIMARY'?'var(--text-primary)':'transparent',color:n[0]==='PRIMARY'?'var(--text-inverse)':'var(--text-secondary)',border:n[0]==='PRIMARY'?'none':'1px solid var(--border-strong)'},
   dotStyle:{width:7,height:7,borderRadius:'50%',flex:'none',background:n[4]==='ok'?'var(--state-success)':'var(--state-running)'},
   style:{flex:'1 1 216px',minWidth:200,display:'flex',flexDirection:'column',gap:7,padding:'11px 12px',border:'1px solid var(--border-subtle)',borderTop:'3px solid '+(n[0]==='PRIMARY'?'var(--text-primary)':n[4]==='ok'?'var(--state-success)':'var(--state-running)'),borderRadius:3,background:'var(--bg-raised)'},
   stats:n[5].map(s=>({k:s[0],v:s[1],style:{fontFamily:MONO,fontSize:12,color:/840|1\.8/.test(s[1])?'var(--state-running)':'var(--text-primary)'}})),
   bars:spark(n[6],12).map(v=>({style:{flex:1,height:Math.round(v*20)+'px',background:n[4]==='ok'?'var(--border-strong)':'color-mix(in oklab, var(--state-running) 55%, transparent)'}}))}));
  const replT='150px 116px 100px 100px 150px minmax(150px,1fr)';
  vals.replHeadStyle={display:'grid',gridTemplateColumns:replT,minWidth:760,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.replRows=[['db-2.internal','synchronous','12 ms','0.2 s','db2_slot',38],['db-3.internal','asynchronous','840 ms','1.8 s','db3_slot',12],['wal-g archive','archive','—','4 min','—',0]].map((r,i)=>({name:r[0],mode:r[1],wlag:r[2],alag:r[3],slot:r[4],share:r[5]?r[5]+'%':'—',
   style:{display:'grid',gridTemplateColumns:replT,minWidth:760,height:rh,borderBottom:i<2?'1px solid var(--border-subtle)':'none'},
   cell:{display:'flex',alignItems:'center',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},
   numCell:{display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,color:'var(--text-secondary)'},
   applyCell:{display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,color:parseFloat(r[3])>1?'var(--state-running)':'var(--text-secondary)'},
   modeStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',whiteSpace:'nowrap',color:r[1]==='synchronous'?'var(--state-success)':r[1]==='archive'?'var(--text-muted)':'var(--state-info)'},
   fillStyle:{display:'block',height:'100%',width:r[5]+'%',background:'var(--state-info)'}}));
  vals.failoverRows=[['2026-06-02 03:41','AUTOMATIC','db-1 lost its disk; db-2 promoted by the manager','38 s'],['2026-03-18 22:10','PLANNED','minor version upgrade, switchover to db-2 and back','11 s'],['2025-11-04 14:02','AUTOMATIC','network partition in 1a, quorum held in 1b','52 s']].map((f,i)=>({when:f[0].slice(0,16),kind:f[1],text:f[2],downtime:f[3],
   kindStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',width:82,flex:'none',color:f[1]==='AUTOMATIC'?'var(--state-running)':'var(--state-info)'},
   style:{display:'flex',alignItems:'center',gap:10,padding:'0 10px',height:rh-4,borderTop:i?'1px solid var(--border-subtle)':'none'}}));
  vals.failover=()=>this.toast('Switchover rehearsal','db-2 is caught up to 12 ms — a planned switchover would cost about 11 seconds of writes. Comb asks for typed confirmation and a maintenance window.','info');
  // data quality tests
  vals.isQualityTab=kind==='quality';vals.isDeployTab=kind==='deploy';
  const DQ=[
   ['t1','users.email is unique','public.users.email','unique',0,[1,1,1,1,1,1,1,1,1,1],'pass'],
   ['t2','users.email is not null','public.users.email','not_null',0,[1,1,1,1,1,1,1,1,1,1],'pass'],
   ['t3','orders.user_id references users','public.orders.user_id','relationship',14,[1,1,1,1,1,0,0,0,0,0],'fail'],
   ['t4','orders.status in the enum','public.orders.status','accepted_values',2,[1,1,1,1,1,1,1,1,0,0],'fail'],
   ['t5','order_items.qty is positive','public.order_items.qty','expression',0,[1,1,1,1,1,1,1,1,1,1],'pass'],
   ['t6','invoices total matches line items','public.invoices','reconciliation',0,[1,1,1,0,1,1,1,1,1,1],'pass'],
   ['t7','events arrive every 5 minutes','public.events','freshness',0,[1,1,1,1,1,1,1,1,1,1],'pass'],
   ['t8','users.mrr is not negative','public.users.mrr','expression',0,[1,1,1,1,1,1,1,1,1,1],'pass']
  ];
  vals.dqSegs=this.seg(['All','Failing','Muted'],S.dqFilter,l=>this.setState({dqFilter:l}));
  const dqF=DQ.filter(t=>{const muted=!!S.dqMuted[t[0]];
   return S.dqFilter==='Muted'?muted:S.dqFilter==='Failing'?(t[6]==='fail'&&!muted):true});
  vals.dqSummary=DQ.filter(t=>t[6]==='fail'&&!S.dqMuted[t[0]]).length+' failing of '+DQ.length+' · ran 4 min ago';
  vals.dqRunLabel=S.dqRunning?'running…':'▷ Run all';
  vals.dqRunStyle={height:22,padding:'0 10px',borderRadius:3,fontSize:12,fontWeight:500,whiteSpace:'nowrap',flex:'none',
   background:S.dqRunning?'var(--bg-hover)':'var(--btn-primary)',color:S.dqRunning?'var(--state-running)':'var(--text-inverse)'};
  vals.runTests=()=>{if(S.dqRunning)return;this.setState({dqRunning:true});clearTimeout(this._dq);
   this._dq=setTimeout(()=>{this.setState({dqRunning:false});this.toast('8 tests ran in 3.2 s','2 failing: orders.user_id has 14 orphans, orders.status has 2 unexpected values.','error')},1400)};
  const dqT='minmax(200px,1fr) 190px 140px 84px 104px 130px';
  vals.dqHeadStyle={display:'grid',gridTemplateColumns:dqT,minWidth:840,position:'sticky',top:0,zIndex:2,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.dqRows=dqF.map(t=>{const muted=!!S.dqMuted[t[0]];const failing=t[6]==='fail'&&!muted;
   return{name:t[1],target:t[2],kind:t[3],failing:t[4]?t[4].toLocaleString():'—',state:muted?'MUTED':failing?'✕ fail':'✓ pass',muteLabel:muted?'unmute':'mute',
    kindStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',whiteSpace:'nowrap',color:'var(--text-secondary)'},
    numCell:{display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,color:t[4]?'var(--state-error)':'var(--text-muted)'},
    stateStyle:{fontFamily:MONO,fontSize:12,whiteSpace:'nowrap',color:muted?'var(--text-muted)':failing?'var(--state-error)':'var(--state-success)'},
    style:{display:'grid',gridTemplateColumns:dqT,minWidth:840,height:rh,borderBottom:'1px solid var(--border-subtle)',cursor:'pointer',opacity:muted?.6:1,
     background:S.dqSel===t[0]?'var(--bg-selected)':failing?'color-mix(in oklab, var(--state-error) 7%, transparent)':'transparent'},
    runs:t[5].map((r,i)=>({title:'run '+(i+1)+(r?' pass':' fail'),style:{width:6,height:13,flex:'none',background:r?'var(--state-success)':'var(--state-error)',opacity:r?.7:1}})),
    onClick:()=>this.setState({dqSel:t[0]}),
    onMute:e=>{e.stopPropagation();this.setState(s=>({dqMuted:Object.assign({},s.dqMuted,{[t[0]]:!muted})}));
     this.toast(muted?'Unmuted':'Muted '+t[1],muted?'It counts against the suite again.':'It still runs — it just stops paging anyone. Muting is recorded.','info')}}});
  const DT=DQ.find(t=>t[0]===S.dqSel)||dqF[0]||DQ[0];
  vals.dqSel=!!DT;vals.closeDq=()=>this.setState({dqSel:null});
  vals.dq={name:DT[1],failing:DT[4],
   rule:DT[3]==='unique'?'count(*) > count(distinct email)':DT[3]==='relationship'?'any row has no parent':DT[3]==='freshness'?'max(created_at) < now() - 5 min':'the expression is false',
   sql:DT[3]==='relationship'?"select o.id, o.user_id\nfrom public.orders o\nleft join public.users u on u.id = o.user_id\nwhere u.id is null;":DT[3]==='unique'?"select email, count(*)\nfrom public.users\ngroup by 1\nhaving count(*) > 1;":DT[3]==='accepted_values'?"select distinct status\nfrom public.orders\nwhere status not in ('paid','shipped','refunded','cancelled');":"select count(*) from public.order_items where qty <= 0;"};
  vals.dqHasFailures=DT[4]>0;
  vals.dqFailures=DT[4]>0?(DT[3]==='relationship'?['(88231, 990412)','(88244, 990517)','(88259, 990517)','(88301, 991002)']:["'pending'","'PAID'"]).map((t,i)=>({text:t,
   style:{display:'flex',alignItems:'center',padding:'0 10px',height:24,borderTop:i?'1px solid var(--border-subtle)':'none',background:'color-mix(in oklab, var(--state-error) 7%, transparent)'}})):[];
  vals.dqOpenRows=()=>{this.newQueryTab();this.toast('Query tab opened','The failing rows query, not run. Look before you fix.','info')};
  vals.dqOpts=[['Run on every schedule tick','Adds about 3 s to the nightly job.'],['Page on failure','Only through PagerDuty, only if critical.'],['Block migrations while failing','A red suite stops the deploy identity.']].map((o,i)=>{const on=S.dqOpts[i];
   return{label:o[0],hint:o[1],onClick:()=>this.setState(s=>{const a=s.dqOpts.slice();a[i]=!a[i];return{dqOpts:a}}),
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  vals.newTest=()=>this.toast('New test','Pick a column and a kind — unique, not null, accepted values, relationship, freshness — or write the SQL that should return zero rows.','info');
  // deployment & license
  vals.latestVersion='1.5.0';vals.updateReady=!S.upgraded;
  vals.upgrade=()=>{this.setState({upgraded:true});this.toast('Upgrade staged','1.5.0 rolls out one API replica at a time. Sessions stay up; workers drain first.','success')};
  vals.deployKpis=[[S.upgraded?'1.5.0':'1.4.2','Version',S.upgraded?'current':'1.5.0 available','ok'],['99.98%','Uptime 90 d','one 38 s failover in June','ok'],['41 / 50','Seats','9 left on the license','ok'],['4.2 GB','Comb database','audit trail is 3.1 GB of it','ok']].map(k=>({value:k[0],label:k[1],note:k[2],
   valueStyle:{fontFamily:MONO,fontSize:20,lineHeight:'26px',fontWeight:500},
   style:{display:'flex',flexDirection:'column',gap:4,padding:'10px 11px',border:'1px solid var(--border-subtle)',borderLeft:'3px solid var(--state-success)',borderRadius:3,background:'var(--bg-raised)'}}));
  const svcT='minmax(180px,1fr) 100px 92px 160px 130px';
  vals.svcHeadStyle={display:'grid',gridTemplateColumns:svcT,minWidth:700,background:'var(--bg-inset)',borderBottom:'1px solid var(--border-strong)',fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'};
  vals.svcRows=[['comb-api','HTTP, sessions, SQL proxy',S.upgraded?'1.5.0':'1.4.2','3 / 3',41,'healthy'],['comb-worker','jobs, exports, PII scans',S.upgraded?'1.5.0':'1.4.2','2 / 2',68,'healthy'],['comb-scheduler','cron, leader-elected',S.upgraded?'1.5.0':'1.4.2','1 / 1',12,'healthy'],['comb-metadata','Postgres 16 · connections, trail, catalog','16.3','1 / 1',34,'healthy'],['comb-migrator','one-shot on deploy',S.upgraded?'1.5.0':'1.4.2','0 / 0',0,'idle']].map((s,i)=>({name:s[0],role:s[1],version:s[2],replicas:s[3],load:s[4]?s[4]+'%':'—',state:s[5].toUpperCase(),
   style:{display:'grid',gridTemplateColumns:svcT,minWidth:700,height:rh+8,borderBottom:i<4?'1px solid var(--border-subtle)':'none'},
   numCell:{display:'flex',alignItems:'center',justifyContent:'flex-end',padding:'0 10px',borderRight:'1px solid var(--border-subtle)',fontFamily:MONO,fontSize:12,color:'var(--text-secondary)'},
   fillStyle:{display:'block',height:'100%',width:s[4]+'%',background:s[4]>80?'var(--state-error)':s[4]>60?'var(--state-running)':'var(--state-success)'},
   stateStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',whiteSpace:'nowrap',color:s[5]==='healthy'?'var(--state-success)':'var(--text-muted)'},
   onLogs:()=>this.toast('Tailing '+s[0],'Structured JSON, 30-day retention, shipped to Datadog if that integration is on.','info')}));
  vals.licTier='ENTERPRISE';
  vals.licStyle={fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',padding:'1px 6px',background:'var(--text-primary)',color:'var(--text-inverse)',whiteSpace:'nowrap'};
  vals.licKey='CMB-ENT-2026-…-4F81';
  vals.seatLabel='41 of 50';
  vals.seatFillStyle={display:'block',height:'100%',width:'82%',background:'var(--state-info)'};
  vals.seatNote='Service identities do not consume a seat. Invited members do, from the moment you invite them.';
  vals.seatNoteStyle={fontSize:11,lineHeight:'15px',color:'var(--text-muted)'};
  vals.licFacts=[['Term','2026-01-01 → 2026-12-31'],['Validation','offline, signed bundle'],['Support','24×7, 1 h P1 response'],['Air-gapped','permitted']].map(l=>({k:l[0],v:l[1]}));
  vals.flags=[['ai.panel','Schema-aware SQL drafting.'],['erd.inferred_edges','Guess relationships where no FK exists.'],['grid.inline_edit','Staged edits on primary-keyed tables.'],['approvals.required_on_prod','Enforce the second pair of eyes.'],['experimental.explain_visualiser','Plan trees as a flame graph. Rough.']].map((fl,i)=>{const on=S.flagState[i];
   return{key:fl[0],hint:fl[1],onClick:()=>this.setState(s=>{const a=s.flagState.slice();a[i]=!a[i];return{flagState:a}}),
    trackStyle:{width:34,height:18,borderRadius:9,flex:'none',background:on?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:on?'flex-end':'flex-start'},
    knobStyle:{width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'}}});
  vals.releaseRows=[['1.5.0','2026-08-12','Column-level masking, DSR plan builder, faster catalog refresh','available'],['1.4.2','2026-07-28','Fixes an ERD layout hang on schemas over 400 tables','installed'],['1.4.0','2026-07-02','Approvals, migrations, scheduled jobs','installed'],['1.3.9','2026-05-19','Audit trail hash chaining','installed']].map((r,i)=>({v:r[0],when:r[1],note:r[2],tag:r[3].toUpperCase(),
   tagStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',whiteSpace:'nowrap',color:r[3]==='available'?'var(--state-running)':'var(--text-muted)'},
   style:{display:'flex',alignItems:'center',gap:10,padding:'0 10px',height:rh-2,borderTop:i?'1px solid var(--border-subtle)':'none'}}));
  // notifications + shortcuts
  const NOTIF={
   n1:['appr','3 statements are waiting on your approval','ap-118 UPDATE orders · 412 rows, plus two more.','18 min',()=>this.openKind('approvals','Approvals')],
   n2:['err','Deadlock on public.orders, twice','Both backends updated the same rows in opposite order.','41 min',()=>this.openKind('monitor','Monitoring')],
   n3:['job','Nightly full export failed once this week','SMTP timeout after 3 retries on 07-31.','2 d',()=>this.openKind('jobs','Jobs')],
   n4:['cat','events.payload has 2 new PII candidates','The weekly scan matched an email and a phone pattern.','3 d',()=>this.openKind('catalog','Data catalog')]};
  vals.notifOpen=S.notifOpen;
  vals.hasNotifs=S.notifs.length>0;vals.notifCount=String(S.notifs.length);
  vals.notifBtnStyle={position:'relative',width:26,height:26,borderRadius:3,color:'var(--text-secondary)',display:'grid',placeItems:'center',background:S.notifOpen?'var(--bg-hover)':'transparent'};
  vals.notifBadgeStyle={position:'absolute',top:1,right:1,minWidth:13,height:13,padding:'0 3px',borderRadius:7,background:'var(--danger)',color:'var(--text-inverse)',fontFamily:MONO,fontSize:9,lineHeight:'13px',textAlign:'center'};
  vals.toggleNotif=()=>this.setState(s=>({notifOpen:!s.notifOpen}));
  vals.closeNotif=()=>this.setState({notifOpen:false});
  vals.clearNotifs=()=>this.setState({notifs:[],notifOpen:false});
  vals.notifEmpty=S.notifs.length===0;
  vals.notifRows=S.notifs.map(id=>{const n=NOTIF[id];
   return{title:n[1],body:n[2],age:n[3],
    dotStyle:{width:6,height:6,borderRadius:'50%',flex:'none',marginTop:6,background:n[0]==='err'?'var(--state-error)':n[0]==='appr'?'var(--state-running)':'var(--state-info)'},
    style:{display:'flex',alignItems:'flex-start',gap:9,padding:'9px 11px',borderBottom:'1px solid var(--border-subtle)',cursor:'pointer'},
    onClick:()=>{this.setState(s=>({notifs:s.notifs.filter(x=>x!==id),notifOpen:false}));n[4]()}}});
  vals.shortcutsOpen=S.shortcuts;
  vals.openShortcuts=()=>this.setState({shortcuts:true});
  vals.closeShortcuts=()=>this.setState({shortcuts:false});
  vals.shortcutGroups=[
   ['Global',[['⌘K','Command palette, objects and actions'],['⌘⇧C','Switch connection'],['⌘B','Toggle the object sidebar'],['⌘I','Toggle the AI panel'],['⌘,','Settings'],['⌘/','This list']]],
   ['Tabs',[['⌘T','New query tab'],['⌘W','Close tab'],['⌘1…9','Jump to tab n'],['⌃⇥','Next tab']]],
   ['Query editor',[['⌘↵','Run the statement at the cursor'],['⌘⇧↵','Run everything'],['⌘.','Cancel the running query'],['⌥⇧F','Format'],['⌘S','Save to the library']]],
   ['Data grid',[['Space','Value inspector'],['↵','Edit the cell'],['⌘↵','Commit staged changes'],['⌘Z','Undo a staged edit'],['⌫','Mark the row for deletion']]]
  ].map(g=>({label:g[0],items:g[1].map(k=>({keys:k[0],label:k[1]}))}));
  // status bar
  const st=q.phase==='running'?'running':q.phase==='error'?'error':'idle';
  vals.statusLabel=st;
  vals.statusDotStyle={width:7,height:7,borderRadius:'50%',background:st==='running'?'var(--state-running)':st==='error'?'var(--state-error)':'var(--state-success)',animation:st==='running'?'combpulse 1.6s ease-in-out infinite':'none'};
  vals.lastQuery=q.phase==='done'?'last query '+q.ms+' ms / '+q.rows.length+' rows':q.phase==='error'?'last query failed '+q.err.code:'no query yet';
  vals.rowSummary=vals.isTableTab?data.length+' rows loaded':(q.rows?q.rows.length+' rows':'—');
  vals.latency='24 ms';
  // palette
  vals.paletteOpen=S.palette;vals.pq=S.pq;vals.paletteQ=S.pq;
  vals.palettePlaceholder=S.switcher?'Switch connection…':'Search tables, queries, actions…';
  vals.onPaletteQ=e=>this.setState({pq:e.target.value});
  vals.closePalette=()=>this.setState({palette:false});
  const pq=S.pq.toLowerCase().replace(/^[>@#]/,'');
  let pool=[];
  if(S.switcher||S.pq.indexOf('c:')===0){pool=S.conns.map(c=>({group:'Connections',icon:'▍',iconColor:this.idc(c),label:c.name,hint:c.env,onClick:()=>{this.setState({palette:false});this.open(c)}}))}
  else{
   pool=pool.concat([['Manage roles & privileges','',()=>this.openKind('roles','Roles')],['AI configuration','',()=>this.openKind('ai','AI configuration')],['Audit trail','',()=>this.openKind('audit','Audit trail')],['Team & access','',()=>this.openKind('team','Team & access')],['Cluster monitoring','',()=>this.openKind('monitor','Monitoring')],['Migrations','',()=>this.openKind('migrations','Migrations')],['Scheduled jobs','',()=>this.openKind('jobs','Jobs')],['Approvals inbox','',()=>this.openKind('approvals','Approvals')],['Data catalog & PII','',()=>this.openKind('catalog','Data catalog')],['Backups & recovery','',()=>this.openKind('backup','Backups')],['Query library','',()=>this.openKind('library','Library')],['Compliance & DSR','',()=>this.openKind('compliance','Compliance')],['Usage & cost','',()=>this.openKind('usage','Usage')],['Cluster topology','',()=>this.openKind('topology','Topology')],['Data quality tests','',()=>this.openKind('quality','Data quality')],['Deployment & license','',()=>this.openKind('deploy','Deployment')],['Security','',()=>this.openKind('security','Security')],['Integrations','',()=>this.openKind('integrations','Integrations')],['Keyboard shortcuts','⌘/',()=>this.setState({shortcuts:true})],['New query tab','⌘T',()=>this.newQueryTab()],['Toggle AI panel','⌘I',()=>this.setState(s=>({aiOpen:!s.aiOpen}))],['Open Settings','⌘,',this.openSettings],['Switch connection','⌘⇧C',()=>this.setState({switcher:true,pq:''})],['Back to connections','',()=>this.setState({route:'launcher',palette:false})],['Toggle theme','',()=>this.setState(s=>({theme:s.theme==='dark'?'light':'dark'}))]].map(a=>({group:'Actions',icon:'›',label:a[0],hint:a[1],onClick:()=>{this.setState({palette:false});a[2]()}})));
   pool=pool.concat(TREE.public.tables.map(n=>({group:'Tables & views',icon:'▤',label:'public.'+n,hint:'table',onClick:()=>{this.setState({palette:false});this.openTable(n)}})));
   pool=pool.concat([['mrr by month','saved query'],['churn cohort','saved query']].map(x=>({group:'Saved queries',icon:'⌗',label:x[0],hint:x[1],onClick:()=>{this.setState({palette:false});this.newQueryTab()}})));
   pool=pool.concat(S.conns.slice(0,3).map(c=>({group:'Connections',icon:'▍',iconColor:this.idc(c),label:c.name,hint:c.env,onClick:()=>{this.setState({palette:false});this.open(c)}})));
  }
  const filt=pool.filter(p=>!pq||p.label.toLowerCase().indexOf(pq)>=0);
  const prows=[];let lastG=null;
  filt.slice(0,24).forEach(p=>{
   if(p.group!==lastG){lastG=p.group;prows.push({label:p.group,hint:'',icon:'',iconStyle:{width:0},labelStyle:{fontFamily:COND,fontSize:11,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase',color:'var(--text-muted)'},style:{display:'flex',alignItems:'center',padding:'8px 12px 3px'},onClick:()=>{}})}
   prows.push({label:p.label,hint:p.hint,icon:p.icon,iconStyle:{width:12,fontSize:11,color:p.iconColor||'var(--text-muted)'},labelStyle:{fontFamily:MONO,fontSize:13},style:{display:'flex',alignItems:'center',gap:9,padding:'0 12px',height:28,cursor:'pointer'},onClick:p.onClick})});
  vals.paletteRows=prows;vals.paletteEmpty=filt.length===0;
  // context menu
  vals.ctxOpen=!!S.ctx;vals.closeCtx=()=>this.setState({ctx:null});
  vals.ctxStyle=S.ctx?{position:'fixed',left:Math.min(S.ctx.x,window.innerWidth-230),top:Math.min(S.ctx.y,window.innerHeight-280),width:222,background:'var(--bg-overlay)',border:'1px solid var(--border-strong)',borderRadius:6,boxShadow:'var(--shadow)',padding:'4px 0'}:{};
  const ctxItem=(label,fn,danger,sep)=>({label,onClick:()=>{this.setState({ctx:null});fn&&fn()},
   style:{padding:'0 12px',height:26,display:'flex',alignItems:'center',fontSize:13,cursor:'pointer',color:danger?'var(--danger)':'var(--text-primary)',borderTop:sep?'1px solid var(--border-subtle)':'none',marginTop:sep?4:0,paddingTop:sep?2:0}});
  const tn=S.ctx?S.ctx.table:'';
  vals.ctxItems=S.ctx?[ctxItem('Open data',()=>this.openTable(tn)),ctxItem('Open structure',()=>{this.openTable(tn);this.setState({sub:'Structure'})}),ctxItem('Copy qualified name',()=>this.toast('Copied public.'+tn,null,'info')),ctxItem('Select 100 rows',()=>{this.newQueryTab();this.toast('Query tab opened','Not run — press ⌘↵.','info')}),ctxItem('Show in ERD',()=>this.setState(s=>({active:(s.tabs.find(x=>x.kind==='erd')||{}).id||s.active,erdFocus:tn}))),
   ctxItem('Truncate…',()=>this.setState({confirm:{kind:'TRUNCATE',table:tn,input:''}}),true,true),
   ctxItem('Drop…',()=>this.setState({confirm:{kind:'DROP',table:tn,input:''}}),true)]:[];
  // confirm
  const cf=S.confirm;
  vals.confirmOpen=!!cf;
  const isRole=cf&&cf.kind==='DROP ROLE';const isMig=cf&&cf.kind==='APPLY MIGRATION';const isRestore=cf&&cf.kind==='RESTORE';
  vals.confirmTitle=cf?(isRestore?'Restore '+cf.table+' in place':isMig?'Apply '+cf.table:isRole?'DROP ROLE '+cf.table:cf.kind+' public.'+cf.table):'';
  vals.confirmBody=cf?(isRestore?'Every session on this connection is disconnected and the database is replaced with its state at the chosen moment. Anything written after that point is gone.':isMig?'This runs CREATE INDEX CONCURRENTLY outside a transaction. If it fails midway an invalid index is left behind and must be dropped by hand.':isRole?'Objects still owned by this role block the drop. Sessions opened by it are not terminated.':cf.kind==='DROP'?'This removes the table and every row in it. On a prod-tagged connection this cannot be undone and there is no snapshot.':'This deletes every row in the table. Sequences are not reset.'):'';
  vals.confirmSql=cf?(isRestore?'-- restore target: '+cf.table+'\n-- point in time: chosen on the recovery slider\n-- est. downtime: 6 min · 14 sessions will be dropped':isMig?'create index concurrently orders_shipped_at_idx\n  on public.orders (shipped_at desc nulls last);\n-- ~40 s · no table lock · not transactional':isRole?'drop role '+cf.table+';\n-- 2 open sessions · owns 0 objects':(cf.kind==='DROP'?'drop table public.'+cf.table+';':'truncate table public.'+cf.table+';')+'\n-- affects ~48,201 rows'):'';
  vals.confirmWord=cf?cf.table:'';
  vals.confirmAction=cf?(isRestore?'RESTORE':isMig?'APPLY':cf.kind):'';
  vals.confirmInput=cf?cf.input:'';
  vals.onConfirmInput=e=>this.setState(s=>({confirm:Object.assign({},s.confirm,{input:e.target.value})}));
  const armed=cf&&cf.input===cf.table;
  vals.confirmBtnStyle={height:28,padding:'0 14px',borderRadius:3,fontSize:13,fontWeight:500,background:armed?'var(--danger)':'var(--bg-hover)',color:armed?'#10151A':'var(--text-muted)',cursor:armed?'pointer':'not-allowed'};
  vals.doConfirm=()=>{if(!armed)return;this.setState({confirm:null});
   if(isRestore){this.toast('Restore started','Recovery to '+vals.pitrTime+' · the connection reappears when the database is up.','error');return}
   if(isMig){this.toast('Migration applied','orders_shipped_at_idx built concurrently in 41 s · index valid · catalog version bumped','success');return}
   if(C.ro)this.toast(cf.kind+' public.'+cf.table+' — blocked','This connection is read-only, so nothing ran. That is the point.','error');
   else this.toast(cf.kind+' public.'+cf.table,cf.kind==='DROP'?'1 table dropped · ~48,201 rows gone · 61 ms':'~48,201 rows removed · 22 ms','success')};
  vals.closeConfirm=()=>this.setState({confirm:null});
  // connection modal
  const F=S.form||{name:'',host:'',port:'5432',db:'',user:'',pass:'',dsn:'',color:'slate',env:'local',ro:false};
  vals.modalOpen=!!S.modal;vals.modalTitle=S.modal==='new'?'New connection':'Edit connection';
  vals.closeModal=()=>this.setState({modal:null});
  vals.form={name:F.name||'untitled',dsn:F.dsn};
  const setF=(k,v)=>this.setState(s=>({form:Object.assign({},s.form,{[k]:v})}));
  vals.onDsn=e=>{const v=e.target.value;const m=/^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:/]+)(?::(\d+))?\/(\w+)/.exec(v);
   if(m)this.setState(s=>({form:Object.assign({},s.form,{dsn:v,user:m[1],pass:m[2]||'',host:m[3],port:m[4]||'5432',db:m[5],name:s.form.name||m[5]})}));
   else setF('dsn',v)};
  vals.formFields=[['Name','name','text','analytics_prod'],['Host','host','text','db.internal'],['Port','port','text','5432'],['Database','db','text','analytics'],['User','user','text','postgres'],['Password','pass','password','••••••••']].map(f=>({label:f[0],value:F[f[1]]||'',type:f[2],ph:f[3],onChange:e=>setF(f[1],e.target.value),wrapStyle:{display:'flex',flexDirection:'column',gap:4,gridColumn:f[1]==='name'?'span 2':'span 1'}}));
  vals.swatches=Object.keys(IDC).map(k=>({onClick:()=>setF('color',k),style:{width:18,height:18,borderRadius:3,background:IDC[k],border:F.color===k?'2px solid var(--text-primary)':'1px solid var(--border-subtle)',outline:F.color===k?'1px solid var(--bg-base)':'none'}}));
  vals.envSegs=this.seg(['Local','Dev','Staging','Prod'],F.env.charAt(0).toUpperCase()+F.env.slice(1),l=>this.setState(s=>({form:Object.assign({},s.form,{env:l.toLowerCase(),ro:l==='Prod'?true:s.form.ro})})));
  vals.toggleFormRO=()=>setF('ro',!F.ro);
  vals.roTrackStyle={width:34,height:18,borderRadius:9,background:F.ro?'var(--state-success)':'var(--border-strong)',display:'flex',alignItems:'center',padding:2,justifyContent:F.ro?'flex-end':'flex-start'};
  vals.roKnobStyle={width:14,height:14,borderRadius:7,background:'var(--bg-raised)',display:'block'};
  vals.roHint=F.env==='prod'?(F.ro?'Recommended for prod — on.':'Overridden. Writes will reach production.'):'Session runs with default_transaction_read_only.';
  vals.roHintStyle={fontSize:12,color:F.env==='prod'&&!F.ro?'var(--danger)':'var(--text-muted)'};
  vals.previewBarStyle={width:3,flex:'none',background:IDC[F.color]};
  vals.previewEnv=F.env.toUpperCase();vals.previewEnvStyle=this.envStyle(F.env);
  vals.previewDsn=(F.host||'host')+':'+(F.port||'5432')+' · '+(F.user||'user');
  const T=S.test;
  vals.testBoxStyle={border:'1px solid '+(T&&T.ok===false?'var(--state-error)':'var(--border-subtle)'),borderLeft:'3px solid '+(T?(T.ok?'var(--state-success)':'var(--state-error)'):'var(--border-strong)'),borderRadius:3,padding:'9px 10px',background:'var(--bg-base)',color:T?(T.ok?'var(--state-success)':'var(--state-error)'):'var(--text-muted)'};
  vals.testText=T?T.text:(S.testing?'testing…':'Not tested yet.');
  vals.testHint=!!(T&&T.hint);vals.testHintText=T&&T.hint?T.hint:'';
  vals.testConn=()=>{this.setState({testing:true,test:null});clearTimeout(this._tc);
   this._tc=setTimeout(()=>{const ok=!!F.host;this.setState({testing:false,test:ok?{ok:true,text:'✓ Connected · PostgreSQL 16.3 · 24 ms · 12 schemas'}:{ok:false,text:'FATAL:  no pg_hba.conf entry for host "10.1.2.3", user "postgres", database "analytics", no encryption',hint:'The server refuses unencrypted connections from this host. Set SSL mode to require, or add a pg_hba entry.'}})},700)};
  vals.saveConn=()=>{this.setState({modal:null});this.toast('Connection saved',(F.name||'untitled')+' · '+F.env+(F.ro?' · read-only':''),'success')};
  // toast
  const tt=S.toast;
  vals.toastOpen=!!tt;
  vals.toastText=tt?tt.text:'';vals.toastSub=!!(tt&&tt.sub);vals.toastSubText=tt&&tt.sub?tt.sub:'';
  vals.toastIcon=tt?(tt.kind==='error'?'✕':tt.kind==='info'?'◆':'✓'):'';
  vals.toastIconStyle={color:tt?(tt.kind==='error'?'var(--state-error)':tt.kind==='info'?'var(--state-info)':'var(--state-success)'):'',fontSize:13,paddingTop:2};
  vals.toastStyle={position:'fixed',right:16,bottom:36,zIndex:99,maxWidth:400,display:'flex',gap:10,alignItems:'flex-start',padding:'10px 12px',background:'var(--bg-overlay)',border:'1px solid var(--border-strong)',borderLeft:'3px solid '+(tt&&tt.kind==='error'?'var(--danger)':tt&&tt.kind==='info'?'var(--state-info)':'var(--state-success)'),borderRadius:6,boxShadow:'var(--shadow)'};
  vals.closeToast=()=>this.setState({toast:null});
  vals.winW=S.winW||(typeof window!=='undefined'?window.innerWidth:1440);
  vals.tooNarrow=vals.winW<720;
  return vals}
}
</script>


