// 固定试卷填空与校验；不调用模型或金融接口，不执行选股。
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../../..');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,''));
const clone=v=>JSON.parse(JSON.stringify(v));
const paper=()=>read('contracts/选股意图试卷.json');
function template(id){const q=paper().questions.find(q=>q.metric_id===id);if(!q)throw Error('未知题目: '+id);return read(path.join('contracts',q.template));}
function createQuestion(id){const t=template(id),a=clone(t.answer);a.active=true;for(const [k,s] of Object.entries(t.slot_definitions))if(s.default!==null)a.slots[k]={value:clone(s.default),source:'default',confirmed:false};return {metric_id:id,...a};}
function fillQuestion(answer,values,originalText){const t=template(answer.metric_id),a=clone(answer);if(originalText!==undefined){if(typeof originalText!=='string')throw Error('原话必须为字符串');a.original_text=originalText;}for(const [key,value] of Object.entries(values)){if(!Object.hasOwn(t.slot_definitions,key))throw Error('不允许填入未知槽位: '+key);a.slots[key]={value:clone(value),source:'user_input',confirmed:false};}a.validation=false;a.validation_errors=[];return a;}
function confirmSlots(answer,keys){const a=clone(answer),t=template(a.metric_id);for(const key of keys){if(!Object.hasOwn(t.slot_definitions,key)||!a.slots[key])throw Error('未知槽位: '+key);a.slots[key].confirmed=true;}a.validation=false;return a;}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
function validDate(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;}
function validateQuestion(answer){
 const t=template(answer.metric_id),a=clone(answer);a.validation=false;a.validation_errors=[];
 const error=(slot,code,message)=>a.validation_errors.push({slot,code,message,question:message,options:t.slot_definitions[slot]?.options||[]});
 if(typeof a.active!=='boolean'){error('active','invalid_type','是否选用该题必须为布尔值');return a;}
 if(!a.active){a.validation=true;return a;}
 if(!a.slots||typeof a.slots!=='object'||Array.isArray(a.slots)){error('slots','invalid_type','请提供槽位答案');return a;}
 for(const key of Object.keys(a.slots))if(!Object.hasOwn(t.slot_definitions,key))error(key,'unknown_slot','存在试卷未定义的槽位: '+key);
 const val=k=>a.slots[k]?.value;
 for(const [key,s] of Object.entries(t.slot_definitions)){
  const entry=a.slots[key],v=entry?.value;
  if(v===null||v===undefined){if(s.required)error(key,'missing',`请填写${s.label}`);continue;}
  let ok=true;
  if(s.kind==='choice')ok=s.options.includes(v);
  if(s.kind==='date')ok=validDate(v);
  if(s.kind==='report')ok=typeof v==='string'&&/^\d{4}-Q[1-4]$/.test(v);
  if(s.kind==='integer')ok=Number.isInteger(v)&&v>0;
  if(s.kind==='number_or_range')ok=val('operator')==='between'?Array.isArray(v)&&v.length===2&&v.every(finite)&&v[0]<=v[1]:finite(v);
  if(!ok)error(key,'invalid_value',`${s.label}的类型、选项或取值不正确`);
  if(!['default','user_input'].includes(entry.source))error(key,'invalid_source',`${s.label}的来源不正确`);
  if(entry.confirmed!==true)error(key,'unconfirmed',`请确认${s.label}：${JSON.stringify(v)}`);
 }
 if(t.slot_definitions.window_trading_days&&val('window_trading_days')!==60)error('window_trading_days','unsupported','当前题目只支持60个交易日');
 if(t.slot_definitions.annualization_days&&val('annualization_days')!==252)error('annualization_days','unsupported','当前计算公式固定按252个交易日年化');
 if(t.slot_definitions.current_quarter&&val('current_quarter')!==val('report'))error('current_quarter','conflict','比较季度必须与财务报告期一致');
 a.validation=a.validation_errors.length===0;return a;
}
function createExam(){const p=paper();return {template_version:p.template_version,context:clone(p.context),questions:p.questions.map(q=>({metric_id:q.metric_id,...template(q.metric_id).answer})),unmapped_inputs:[],validation:false,validation_errors:[]};}
function validateExam(input){
 const a=clone(input),errors=[];
 a.questions=(a.questions||[]).map(q=>validateQuestion(q));
 const expected=paper().questions.map(q=>q.metric_id),ids=a.questions.map(q=>q.metric_id);
 if(ids.length!==expected.length||new Set(ids).size!==ids.length||expected.some(id=>!ids.includes(id)))errors.push({code:'question_set_changed',message:'必须保留固定试卷的全部题目，未使用题目设置active=false'});
 if(!a.questions.some(q=>q.active))errors.push({code:'no_active_question',message:'请选择至少一个筛选指标'});
 const u=a.context?.universe,uv=u?.value;
 const universeValid=uv&&((uv.type==='explicit_symbols'&&Array.isArray(uv.symbols)&&uv.symbols.length>0&&uv.symbols.every(s=>typeof s==='string'&&/^\d{6}\.(SH|SZ|BJ)$/.test(s)))||(uv.type==='index_constituents'&&typeof uv.index_code==='string'&&/^\d{6}\.(SH|SZ|BJ)$/.test(uv.index_code)));
 if(!universeValid||u.confirmed!==true)errors.push({code:'universe_required',message:'请选择并确认股票池（股票代码列表或指数代码）'});
 if(!['all','any'].includes(a.context?.combination?.value)||a.context.combination.confirmed!==true)errors.push({code:'combination_required',message:'请确认全部满足还是任一满足'});
 const openUnmapped=Array.isArray(a.unmapped_inputs)?a.unmapped_inputs.filter(x=>typeof x==='string'||x?.status!=='resolved'):[];
 if(!Array.isArray(a.unmapped_inputs)||openUnmapped.length)errors.push({code:'unmapped_intent',message:'存在未映射需求，请选择指标或明确放弃该条件'});
 for(const q of a.questions.filter(q=>q.active))for(const e of q.validation_errors)errors.push({metric_id:q.metric_id,...e});
 a.validation_errors=errors;a.validation=errors.length===0;return a;
}
function checkDataReadiness(answer){const t=template(answer.metric_id),m=read(path.join('contracts',t.metric_file));return {metric_id:answer.metric_id,ready:m.enabled_for_screening===true,availability:m.availability,reason:m.enabled_for_screening?'仍需在执行时核验本次数据质量':'数据口径尚未验收，不能执行；无需客户重复填写已有效答案'};}
module.exports={createQuestion,fillQuestion,confirmSlots,validateQuestion,createExam,validateExam,checkDataReadiness};
