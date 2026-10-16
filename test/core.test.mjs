import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAllowedOrigins, assertOrigin, unpackToolOutcome, normalizeObservation,
  buildCandidates, buildJevQuestion, runBrowserTask,
} from '../src/core.mjs';

const origin = 'https://en.wikipedia.org';
const ALLOWED = [origin];
const wrap = (value, error=false) => ({ isError:error, result:{content:[{type:'text',text:JSON.stringify(value)}],details:undefined} });
const tab = { id:17, title:'Wikipedia', url:origin+'/wiki/Main_Page', owner:'agent' };
const snap = (url, title, elements, snapshotId='s1', extras={}) => ({
  tab:{...tab,url,title},tabId:17,
  snapshot:{snapshotId, url, title, elements, ...extras},
});

function harness({ pages, choices, onCall, newTab=true }={}) {
  const calls = [], decisions = [];
  let index=0, answer=0;
  const deps = {
    allowedOrigins:ALLOWED,
    async call(name,args) {
      calls.push({name,args});
      onCall?.(name,args);
      if (name==='browser_status') return wrap({connected:true});
      if (name==='browser_new_tab') return wrap({tab:{id:17}});
      if (name==='browser_selected') return wrap({tab:{id:17, url:origin+'/wiki/Main_Page'}});
      if (name==='browser_tabs') return wrap({tabs:[{...tab,owner:'user',sessionScope:'user'}]});
      if (name==='browser_snapshot') return wrap(pages[Math.min(index++,pages.length-1)]);
      return wrap({ok:true});
    },
    async decide(question) {
      decisions.push(question);
      const entry=choices[Math.min(answer++,choices.length-1)];
      return typeof entry==='string' ? {choice:entry,probability:0.98} : entry;
    },
  };
  return {deps,calls,decisions};
}

test('strict allowlist normalization and denied implicit access',() => {
  const exact = parseAllowedOrigins('https://github.com, https://github.com/');
  assert.deepEqual(exact.patterns, ['https://github.com','https://github.com']);
  assert.ok(exact.has('https://github.com'));
  assert.ok(!exact.has('https://github.com:8443'));
  assert.throws(()=>parseAllowedOrigins('https://github.com/path'),/只能是/);
  assert.throws(()=>parseAllowedOrigins('https://*.*.com'),/通配符/);
  assert.throws(()=>parseAllowedOrigins('file:///tmp/file'),/只支持/);
  assert.throws(()=>assertOrigin('https://evil.test',new Set(ALLOWED)),/未获授权/);
});

test('wildcard allowlists match subdomains but never the apex or a look-alike',() => {
  const allowed = parseAllowedOrigins(['*.wikipedia.org']);
  assert.ok(allowed.has('https://en.wikipedia.org'));
  assert.ok(allowed.has('https://zh.m.wikipedia.org'));
  assert.ok(!allowed.has('https://wikipedia.org'));
  assert.ok(!allowed.has('https://evwikipedia.org'));
  assert.ok(!allowed.has('https://en.wikipedia.org.evil.test'));
  assert.ok(!allowed.has('http://en.wikipedia.org'));
  assert.ok(!allowed.has('https://en.wikipedia.org:8443'));
});

test('any-host and explicit-port allowlist entries',() => {
  const anyHost = parseAllowedOrigins(['https://*']);
  assert.ok(anyHost.has('https://anything.test'));
  assert.ok(!anyHost.has('http://anything.test'));
  const localhost = parseAllowedOrigins(['http://localhost:3000']);
  assert.ok(localhost.has('http://localhost:3000'));
  assert.ok(!localhost.has('http://localhost'));
  assert.ok(!localhost.has('https://localhost:3000'));
});

test('nested browser tool errors are not mistaken for success',() => {
  const response = {isError:false,result:{content:[{type:'text',text:'Browser error: uncertain'}],details:{error:'uncertain',code:'BROWSER_OPERATION_UNCERTAIN'}}};
  assert.throws(()=>unpackToolOutcome(response,'browser_click'),/BROWSER_OPERATION_UNCERTAIN/);
  assert.deepEqual(unpackToolOutcome(wrap({ok:true}),'browser_status'),{ok:true});
});

test('raw snapshot normalization strips values, secrets and cross-origin controls',() => {
  const raw=snap(origin+'/search','Search',[
    {ref:'e1',role:'searchbox',name:'Search',value:'private query'},
    {ref:'e2',role:'textbox',name:'Password',value:'abc'},
    {ref:'e3',role:'button',name:'Delete account'},
    {ref:'e4',role:'link',name:'Home',href:'https://evil.test'},
    {ref:'e5',role:'link',name:'Ada Lovelace',href:'/wiki/Ada_Lovelace'},
    {ref:'e6',role:'button',name:'Search',disabled:true},
  ],'id',{text:'x@example.com user@example.com'});
  const page=normalizeObservation(raw,17,new Set(ALLOWED),true);
  assert.equal(page.elements.length,4); // e1, e3, e4, e5
  assert.doesNotMatch(JSON.stringify(page),/private query|Password|x@example.com/);
  const candidates=buildCandidates(page,{inputs:[{field:'Search',value:'Ada Lovelace'}]}, {filled:new Set(),scrolls:0,pendingSearch:null},new Set(ALLOWED));
  assert.ok(candidates.some(c=>c.choice==='FILL:e1'));
  assert.ok(candidates.some(c=>c.choice==='CLICK:e5'));
  assert.ok(!candidates.some(c=>['CLICK:e3','CLICK:e4','CLICK:e6'].includes(c.choice)));
  const packet=buildJevQuestion({goal:'Search for Ada',observation:page,candidates,history:[]});
  // The typed value and the sensitive field must never reach the classifier state;
  // ordinary link labels legitimately do.
  assert.doesNotMatch(JSON.stringify(packet.state),/private query|Password/);
  assert.equal(typeof packet.state,'object');
  assert.ok(Array.isArray(packet.state.page.controls));
  assert.doesNotMatch(JSON.stringify(packet),/private query|x@example.com|user@example.com/);
  assert.doesNotMatch(JSON.stringify(packet.questions),/value":"Ada Lovelace/);
});

test('one Pi call drives fill -> enter -> link -> done through Jev; field value never goes to Jev',async () => {
  const start=snap(origin+'/wiki/Main_Page','Wikipedia',[
    {ref:'e1',role:'searchbox',name:'Search Wikipedia'},
    {ref:'e2',role:'button',name:'Search'},
  ],'s1');
  const afterFill=snap(origin+'/wiki/Main_Page','Wikipedia',[
    {ref:'e1',role:'searchbox',name:'Search Wikipedia',value:'Ada Lovelace'},
    {ref:'e2',role:'button',name:'Search'},
  ],'s2');
  const search=snap(origin+'/w/index.php?search=Ada','Search results',[
    {ref:'e3',role:'link',name:'Ada Lovelace',href:'/wiki/Ada_Lovelace'},
  ],'s3');
  const found=snap(origin+'/wiki/Ada_Lovelace','Ada Lovelace',[
    {ref:'e4',role:'link',name:'Biography',href:'/wiki/Ada_Lovelace#Biography'},
  ],'s4');
  const {deps,calls,decisions}=harness({pages:[start,afterFill,search,found,found],choices:['FILL:e1','PRESS_ENTER:e1','CLICK:e3','DONE']});
  const result=await runBrowserTask({goal:'Find and open Ada Lovelace biography',url:origin+'/wiki/Main_Page',inputs:[{field:'Search',value:'Ada Lovelace'}]},deps);
  assert.equal(result.status,'done_unverified',JSON.stringify(result));
  assert.equal(result.url,origin+'/wiki/Ada_Lovelace');
  assert.deepEqual(calls.filter(c=>['browser_fill','browser_press_key','browser_click'].includes(c.name)).map(c=>[c.name,c.args.ref]),[
    ['browser_fill','e1'],['browser_press_key','e1'],['browser_click','e3'],
  ]);
  assert.equal(calls.at(-1).name,'browser_mark_handoff');
  assert.ok(decisions.every(d=>!JSON.stringify(d.questions).includes('private query')));
  const leakedField=decisions.some(d=>JSON.stringify(d.questions).includes('"value":"Ada Lovelace"'));
  assert.equal(leakedField,false);
  assert.ok(!JSON.stringify(result).includes('"value":"Ada Lovelace"'));
});

test('user existing tab is claimed but never kept as Agent-created',async() => {
  const p=snap(origin+'/wiki/Main_Page','Wikipedia',[{ref:'e1',role:'link',name:'Ada',href:'/wiki/Ada'}]);
  const {deps,calls}=harness({pages:[p,p],choices:['DONE']});
  const result=await runBrowserTask({goal:'Check title',selected:true},deps);
  assert.equal(result.status,'done_unverified');
  assert.ok(calls.some(c=>c.name==='browser_claim_tab'));
  assert.ok(!calls.some(c=>c.name==='browser_new_tab' || c.name==='browser_mark_handoff'));
});

test('invalid choice is never executed',async() => {
  const p=snap(origin+'/wiki/Main_Page','Wikipedia',[{ref:'e1',role:'link',name:'Ada',href:'/wiki/Ada'}]);
  const {deps,calls}=harness({pages:[p],choices:['CLICK:e999']});
  const result=await runBrowserTask({goal:'Navigate',url:origin+'/wiki/Main_Page'},deps);
  assert.equal(result.status,'uncertain');
  assert.ok(!calls.some(c=>c.name==='browser_click'));
});

test('a low-confidence DONE is accepted because it has no side effects',async() => {
  const p=snap(origin+'/wiki/Ada_Lovelace','Ada Lovelace',[{ref:'e1',role:'link',name:'Biography',href:'/wiki/Biography'}],'s2');
  const {deps,calls}=harness({pages:[p,p],choices:[{choice:'DONE',probability:0.31}]});
  const result=await runBrowserTask({goal:'Open the biography',url:origin+'/wiki/Main_Page'},deps);
  assert.equal(result.status,'done_unverified');
  assert.ok(!calls.some(c=>c.name==='browser_click'));
});

test('a low-confidence WAIT is accepted but still bounded',async() => {
  const p=snap(origin+'/wiki/Main_Page','Wikipedia',[{ref:'e1',role:'link',name:'Ada',href:'/wiki/Ada'}]);
  const {deps,calls}=harness({pages:[p,p],choices:[{choice:'WAIT',probability:0.2}]});
  const result=await runBrowserTask({goal:'Read the page',url:origin+'/wiki/Main_Page'},deps);
  assert.ok(result.status!=='uncertain');
});

test('low-confidence action stops without an action',async() => {
  const p=snap(origin+'/wiki/Main_Page','Wikipedia',[{ref:'e1',role:'link',name:'Ada',href:'/wiki/Ada'}]);
  const {deps,calls}=harness({pages:[p],choices:[{choice:'CLICK:e1',probability:0.51}]});
  const result=await runBrowserTask({goal:'Navigate',url:origin+'/wiki/Main_Page'},deps);
  assert.equal(result.status,'uncertain');
  assert.ok(!calls.some(c=>c.name==='browser_click'));
});

test('captcha challenge stops BEFORE Jev evaluation and actions',async() => {
  const p=snap(origin+'/wiki/Main_Page','Human verification',[{ref:'e1',role:'button',name:'Verify you are human'}]);
  const {deps,decisions,calls}=harness({pages:[p],choices:['CLICK:e1']});
  const result=await runBrowserTask({goal:'Read the article',url:origin+'/wiki/Main_Page'},deps);
  assert.equal(result.status,'needs_review');
  assert.equal(decisions.length,0);
  assert.ok(!calls.some(c=>c.name==='browser_click'));
});

test('cross-origin page change stops before external page content is sent to Jev',async() => {
  const p1=snap(origin+'/wiki/Main_Page','Wikipedia',[{ref:'e1',role:'link',name:'Go',href:'/wiki/Redirect'}]);
  const p2=snap('https://evil.test/home','Outside',[{ref:'e2',role:'textbox',name:'private'}]);
  const {deps,decisions,calls}=harness({pages:[p1,p2],choices:['CLICK:e1','DONE']});
  const result=await runBrowserTask({goal:'Navigate',url:origin+'/wiki/Main_Page'},deps);
  assert.equal(result.status,'interrupted');
  assert.equal(decisions.length,1);
  assert.equal(calls.filter(c=>c.name==='browser_click').length,1);
});

test('uncertain click is not replayed',async() => {
  const p=snap(origin+'/wiki/Main_Page','Wikipedia',[{ref:'e1',role:'link',name:'Ada',href:'/wiki/Ada'}]);
  let clickCount=0;
  const {deps,calls}=harness({pages:[p],choices:['CLICK:e1'],onCall(name){if(name==='browser_click')clickCount++;}});
  const old=deps.call;
  deps.call=async(name,args,signal)=>name==='browser_click' ? ({isError:false,result:{content:[{type:'text',text:'Browser error: result unknown'}],details:{error:'result unknown',code:'BROWSER_OPERATION_UNCERTAIN'}}}) : old(name,args,signal);
  const result=await runBrowserTask({goal:'Open Ada',url:origin+'/wiki/Main_Page'},deps);
  assert.equal(result.status,'interrupted');
  assert.equal(clickCount,0); // intercepted before original mock, not repeated
  assert.equal(calls.filter(c=>c.name==='browser_click').length,0);
});

test('no allowlist means zero browser or Jev activity',async() => {
  let invoked=false;
  const result=await assert.rejects(()=>runBrowserTask({goal:'Read',url:origin}, {
    allowedOrigins:[],call:async()=>{invoked=true;},decide:async()=>{invoked=true;},
  }),/先配置/);
  assert.equal(invoked,false);
});

test('bad source inputs are blocked before any browser operation',async() => {
  const {deps,calls}=harness();
  await assert.rejects(()=>runBrowserTask({goal:'Login',url:origin,inputs:[{field:'password',value:'abc'}]},deps),/敏感字段/);
  assert.equal(calls.length,0);
});

test('search-labelled textbox may submit with Enter (GitHub/Google style search boxes)',async () => {
  const start=snap(origin+'/repo','Repo',[{ref:'e1',role:'textbox',name:'Search the site'}],'s1');
  const afterFill=snap(origin+'/repo','Repo',[{ref:'e1',role:'textbox',name:'Search the site',value:'query'}],'s2');
  const results=snap(origin+'/search','Results',[{ref:'e2',role:'link',name:'Result one',href:'/one'}],'s3');
  const found=snap(origin+'/one','Result one',[{ref:'e3',role:'link',name:'Body',href:'/one#body'}],'s4');
  const {deps,calls,decisions}=harness({pages:[start,afterFill,results,found,found],choices:['FILL:e1','PRESS_ENTER:e1','DONE']});
  const result=await runBrowserTask({goal:'Search the site and read the first result',url:origin+'/repo',inputs:[{field:'Search the site',value:'query'}]},deps);
  const secondKeys=Object.keys(decisions[1].questions.action.criteria);
  assert.ok(secondKeys.includes('PRESS_ENTER:e1'),JSON.stringify(secondKeys));
  assert.equal(result.status,'done_unverified',JSON.stringify(result));
  assert.deepEqual(calls.filter(c=>c.name==='browser_press_key').map(c=>c.args.ref),['e1']);
});

test('a non-search textbox never gets an Enter submit candidate',async () => {
  const start=snap(origin+'/form','Form',[{ref:'e1',role:'textbox',name:'Your name'}],'s1');
  const afterFill=snap(origin+'/form','Form',[{ref:'e1',role:'textbox',name:'Your name',value:'Ada'}],'s2');
  const {deps,calls,decisions}=harness({pages:[start,afterFill,afterFill],choices:['FILL:e1','DONE']});
  const result=await runBrowserTask({goal:'Fill the name field',url:origin+'/form',inputs:[{field:'Your name',value:'Ada'}]},deps);
  const secondKeys=Object.keys(decisions[1].questions.action.criteria);
  assert.ok(!secondKeys.some(k=>k.startsWith('PRESS_ENTER')),JSON.stringify(secondKeys));
  assert.ok(!calls.some(c=>c.name==='browser_press_key'));
  assert.equal(result.status,'done_unverified',JSON.stringify(result));
});

test('reading a long page may scroll many times without tripping the repeat guard',async () => {
  const pages=[0,1,2,3,4,5,6].map(i=>snap(origin+`/long?p=${i}`,`Long page ${i}`,[{ref:`e${i+1}`,role:'link',name:`Section ${i}`,href:`/long#${i}`}],`s${i}`));
  const {deps,calls}=harness({pages,choices:['SCROLL_DOWN','SCROLL_DOWN','SCROLL_DOWN','SCROLL_DOWN','SCROLL_DOWN','DONE']});
  const result=await runBrowserTask({goal:'Read the long page',url:origin+'/long'},deps);
  assert.equal(result.status,'done_unverified',JSON.stringify(result));
  assert.equal(calls.filter(c=>c.name==='browser_scroll').length,5);
});

test('malformed href cannot abort the task',async () => {
  const p=snap(origin+'/wiki/Main_Page','Wikipedia',[
    {ref:'e1',role:'link',name:'Broken',href:'http://['},
    {ref:'e2',role:'link',name:'Good',href:'/wiki/Good'},
  ]);
  const {deps,decisions}=harness({pages:[p,p],choices:['DONE']});
  const result=await runBrowserTask({goal:'Read the page',url:origin+'/wiki/Main_Page'},deps);
  assert.equal(result.status,'done_unverified',JSON.stringify(result));
  const keys=Object.keys(decisions[0].questions.action.criteria);
  assert.ok(keys.includes('CLICK:e2'));
  assert.ok(!keys.includes('CLICK:e1'));
});

test('a disconnected Chrome relay is reported as interrupted, not as a snapshot error',async () => {
  const p=snap(origin+'/wiki/Main_Page','Wikipedia',[]);
  const {deps}=harness({pages:[p],choices:['DONE']});
  const original=deps.call;
  deps.call=async(name,args,signal)=>name==='browser_status' ? wrap({state:'disconnected'}) : original(name,args,signal);
  const result=await runBrowserTask({goal:'Read',url:origin+'/wiki/Main_Page'},deps);
  assert.equal(result.status,'interrupted');
  assert.match(result.warnings.join(' '),/Chrome Relay/);
});

test('a pending search submit is explicitly permitted so Jev does not answer BLOCKED',async () => {
  const start=snap(origin+'/wiki/Main_Page','Main Page',[
    {ref:'e1',role:'searchbox',name:'Search Wikipedia'},
    {ref:'e2',role:'button',name:'Search'},
  ],'s1');
  const afterFill=snap(origin+'/wiki/Main_Page','Main Page',[
    {ref:'e1',role:'searchbox',name:'Search Wikipedia',value:'Ada Lovelace'},
    {ref:'e2',role:'button',name:'Search'},
  ],'s2');
  const results=snap(origin+'/wiki/Ada_Lovelace','Ada Lovelace',[{ref:'e3',role:'link',name:'References',href:'/wiki/Ada_Lovelace#References'}],'s3');
  const {deps,decisions}=harness({pages:[start,afterFill,results,results],choices:['FILL:e1','PRESS_ENTER:e1','DONE']});
  const result=await runBrowserTask({goal:'在 Wikipedia 搜索 Ada Lovelace',url:origin+'/wiki/Main_Page',inputs:[{field:'Search',value:'Ada Lovelace'}]},deps);
  const second=decisions[1].questions.action;
  assert.match(second.instructions.rules,/Exception to the submit ban/);
  assert.equal(second.criteria['PRESS_ENTER:e1'].permitted,true);
  assert.equal(second.criteria['CLICK:e2'].permitted,true);
  assert.equal(result.status,'done_unverified',JSON.stringify(result));
});

test('a permitted submit runs even when Jev lands below the confidence floor',async () => {
  const start=snap(origin+'/wiki/Main_Page','Main Page',[
    {ref:'e1',role:'searchbox',name:'Search Wikipedia'},
    {ref:'e2',role:'button',name:'Search'},
  ],'s1');
  const afterFill=snap(origin+'/wiki/Main_Page','Main Page',[
    {ref:'e1',role:'searchbox',name:'Search Wikipedia',value:'Ada Lovelace'},
    {ref:'e2',role:'button',name:'Search'},
  ],'s2');
  const results=snap(origin+'/wiki/Ada_Lovelace','Ada Lovelace',[{ref:'e3',role:'link',name:'References',href:'/wiki/Ada_Lovelace#References'}],'s3');
  const {deps,calls}=harness({pages:[start,afterFill,results,results],
    choices:['FILL:e1',{choice:'PRESS_ENTER:e1',probability:0.5},{choice:'DONE',probability:0.42}]});
  const result=await runBrowserTask({goal:'在 Wikipedia 搜索 Ada Lovelace',url:origin+'/wiki/Main_Page',inputs:[{field:'Search',value:'Ada Lovelace'}]},deps);
  assert.ok(calls.some(c=>c.name==='browser_press_key'),'the pre-authorised Enter must still be executed');
  assert.equal(result.status,'done_unverified',JSON.stringify(result));
  assert.ok(!result.trace.some(t=>t.status==='low_confidence'),JSON.stringify(result.trace));
});

test('no submit carve-out is granted when nothing is pending submission',async () => {
  const page=snap(origin+'/wiki/Main_Page','Main Page',[{ref:'e1',role:'button',name:'Search'}]);
  const {deps,decisions}=harness({pages:[page,page],choices:['DONE']});
  await runBrowserTask({goal:'Read the page',url:origin+'/wiki/Main_Page'},deps);
  const first=decisions[0].questions.action;
  assert.doesNotMatch(first.instructions.rules,/Exception to the submit ban/);
  assert.equal(first.criteria['CLICK:e1'].permitted,undefined);
});

test('a requested FILL is marked permitted so Jev does not split its confidence',async () => {
  const page=snap(origin+'/wiki/Main_Page','Main Page',[{ref:'e1',role:'searchbox',name:'Search Wikipedia'}]);
  const {deps,decisions}=harness({pages:[page,page],choices:['FILL:e1','DONE']});
  await runBrowserTask({goal:'搜索 Ada Lovelace',url:origin+'/wiki/Main_Page',inputs:[{field:'Search',value:'Ada Lovelace'}]},deps);
  const first=decisions[0].questions.action;
  assert.equal(first.criteria['FILL:e1'].permitted,true);
  assert.match(first.instructions.rules,/a FILL action marked permitted/);
});

test('the page search BUTTON stays pre-authorised: criteria and local gate agree',async () => {
  // Regression: Wikipedia's own Search button. The prompt told Jev the button was
  // permitted, but only the criteria carried the flag while the confidence-floor
  // gate read the candidate, so a correct low-probability click was vetoed and the
  // task died at `uncertain` one step after a successful fill.
  const start=snap(origin+'/wiki/Main_Page','Main Page',[
    {ref:'e4',role:'searchbox',name:'Search Wikipedia'},
    {ref:'e5',role:'button',name:'Search'},
  ],'s1');
  const afterFill=snap(origin+'/wiki/Main_Page','Main Page',[
    {ref:'e4',role:'searchbox',name:'Search Wikipedia',value:'Grace Hopper'},
    {ref:'e5',role:'button',name:'Search'},
  ],'s2');
  const results=snap(origin+'/wiki/Grace_Hopper','Grace Hopper',[{ref:'e6',role:'link',name:'References',href:'/wiki/Grace_Hopper#References'}],'s3');
  const {deps,calls,decisions}=harness({pages:[start,afterFill,results,results],
    choices:['FILL:e4',{choice:'CLICK:e5',probability:0.5},{choice:'DONE',probability:0.42}]});
  const result=await runBrowserTask({goal:'search Grace Hopper on Wikipedia',url:origin+'/wiki/Main_Page',inputs:[{field:'Search',value:'Grace Hopper'}]},deps);
  assert.equal(decisions[1].questions.action.criteria['CLICK:e5'].permitted,true);
  assert.ok(calls.some(c=>c.name==='browser_click'&&c.args.ref==='e5'),'the pre-authorised search button must still be clicked');
  assert.equal(result.status,'done_unverified',JSON.stringify(result));
  assert.ok(!result.trace.some(t=>t.status==='low_confidence'),JSON.stringify(result.trace));
});

test('the search-button carve-out needs a pending submit and a search label',async () => {
  // No FILL happened, so nothing is pending submission: the button must stay
  // subject to the confidence floor and must not be advertised as permitted.
  const page=snap(origin+'/wiki/Main_Page','Main Page',[
    {ref:'e1',role:'button',name:'Search'},
    {ref:'e2',role:'button',name:'Hide Appearance'},
  ]);
  const {deps,decisions}=harness({pages:[page,page],choices:['DONE']});
  await runBrowserTask({goal:'Read the page',url:origin+'/wiki/Main_Page'},deps);
  const first=decisions[0].questions.action;
  assert.equal(first.criteria['CLICK:e1'].permitted,undefined);
  // A button that is not search-labelled is never offered as a CLICK at all,
  // so it cannot be pre-authorised either.
  assert.equal(first.criteria['CLICK:e2'],undefined);
});
