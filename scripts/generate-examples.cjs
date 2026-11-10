// 用本地校验器生成可读的填写前后示例；不取金融数据。
const fs=require('fs'),path=require('path');
const {createQuestion,fillQuestion,confirmSlots,validateQuestion,checkDataReadiness}=require('../backend/app/intent/questionnaire.cjs');
const dir=path.resolve(__dirname,'../contracts/examples');fs.mkdirSync(dir,{recursive:true});
let question=createQuestion('pe_ttm');
const missing=validateQuestion(question);
question=fillQuestion(question,{operator:'lt',threshold:20,as_of:'2026-11-06'},'截至2026年11月6日，找PE低于20倍的股票');
question=confirmSlots(question,Object.keys(question.slots));
const complete=validateQuestion(question);
for(const [file,value] of [['市盈率_待补充.json',missing],['市盈率_已确认.json',{...complete,data_readiness:checkDataReadiness(complete)}]])fs.writeFileSync(path.join(dir,file),JSON.stringify(value,null,2)+'\n');
console.log('Generated 2 local questionnaire examples; no financial API calls.');
