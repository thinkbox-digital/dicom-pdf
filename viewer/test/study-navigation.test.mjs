import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStudyModel,createStudyNavigation,formatStudyDate,modalityLabel} from '../study-navigation.mjs';
import {buildPaneInventory} from '../pane-inventory.mjs';
import {createStackOrder} from '../stack-order.mjs';

const entry=(fields={},extra={})=>({attachment:'original.dcm',sourcePath:'original.dcm',status:'rendered',displayRejected:false,fields:{Rows:'10',Columns:'20',...fields},...extra});

test('series cards select and preview the first slice in sidebar order while retaining global indices',()=>{
  const entries=[30,10,20].map((z,index)=>entry({StudyInstanceUID:'s',SeriesInstanceUID:'r',ImageOrientationPatient:'1\\0\\0\\0\\1\\0',ImagePositionPatient:`0\\0\\${z}`},{attachment:`source-${index}`}));
  const stackOrder=createStackOrder(entries),series=buildStudyModel(entries,{stackOrder}).studies[0].series[0];
  assert.deepEqual(series.indices,[1,2,0]);assert.equal(series.selectionIndex,1);assert.equal(series.thumbnailIndex,1);
  const container=navigationContainer(),selected=[];
  const navigation=createStudyNavigation({container,entries,stackOrder,onSelect:index=>selected.push(index)});
  container.querySelector('.series-card').dispatch('click');assert.deepEqual(selected,[1]);
  assert.equal(entries[1].attachment,'source-1');navigation.destroy();
});

test('specialized objects use readable modality labels',()=>{
  assert.equal(modalityLabel('RTDOSE'),'Radiotherapy dose data');assert.equal(modalityLabel('RTPLAN'),'Radiotherapy plans');
  assert.equal(modalityLabel('RTSTRUCT'),'Radiotherapy structures');assert.equal(modalityLabel('SEG'),'Segmentation data');
});

test('groups by supplied study and series IDs while retaining duplicate instance files',()=>{
  const entries=[entry({StudyInstanceUID:'study',SeriesInstanceUID:'b',SeriesNumber:'2',SOPInstanceUID:'duplicate'}),
    entry({StudyInstanceUID:'study',SeriesInstanceUID:'a',SeriesNumber:'1',SOPInstanceUID:'duplicate'}),
    entry({StudyInstanceUID:'study',SeriesInstanceUID:'b',SeriesNumber:'2',SOPInstanceUID:'duplicate'})];
  const model=buildStudyModel(entries);assert.equal(model.studies.length,1);
  assert.deepEqual(model.studies[0].series.map(series=>series.uid),['a','b']);
  assert.deepEqual(model.studies[0].series[1].indices,[0,2]);assert.equal(model.byIndex.size,3);
  assert.equal(model.studies[0].count,3);assert.notEqual(model.byIndex.get(0).seriesKey,model.byIndex.get(1).seriesKey);
});
test('absent study or series UIDs never merge otherwise unrelated originals',()=>{
  const model=buildStudyModel([entry({StudyDate:'20260101',SeriesInstanceUID:'shared',SOPInstanceUID:'same'}),
    entry({StudyDate:'20260101',SeriesInstanceUID:'shared',SOPInstanceUID:'same'}),
    entry({StudyInstanceUID:'known'}),entry({StudyInstanceUID:'known'})]);
  assert.equal(model.studies.length,3);assert.equal(model.studies.find(study=>study.uid==='known').series.length,2);
  assert.notEqual(model.byIndex.get(0).studyKey,model.byIndex.get(1).studyKey);
});
test('uses actual enriched fields but selected source fields retain precedence',()=>{
  const model=buildStudyModel([entry({StudyInstanceUID:'study',SeriesInstanceUID:'series',StudyDate:'20261115',BodyPartExamined:'CHEST',Modality:'CT',SeriesDescription:'Supplied series'},
    {navigationFields:{InstitutionName:'Supplied facility',BodyPartExamined:'WRONG'}})]);
  const study=model.studies[0];assert.equal(study.dateLabel,'15 Nov 2026');assert.equal(study.facility,'Supplied facility');assert.equal(study.bodyArea,'CHEST');
  assert.equal(study.series[0].modalityLabel,'CT images');assert.equal(study.series[0].description,'Supplied series');
});
test('dates are strict calendar dates, including leap years, without zone conversion',()=>{
  assert.equal(formatStudyDate('20240229'),'29 Feb 2024');assert.equal(formatStudyDate('20000229'),'29 Feb 2000');
  for(const value of ['19000229','20250229','20261301','20261131','00000101','2026','2026-11-15'])assert.equal(formatStudyDate(value),'Date unavailable',value);
  assert.equal(formatStudyDate(null),'Date not provided');assert.equal(formatStudyDate(''),'Date not provided');
});
test('newest actual study dates precede missing or invalid dates with stable ties',()=>{
  const model=buildStudyModel([entry({StudyInstanceUID:'missing'}),entry({StudyInstanceUID:'old',StudyDate:'20200101'}),
    entry({StudyInstanceUID:'new',StudyDate:'20261115'}),entry({StudyInstanceUID:'invalid',StudyDate:'bad'}),entry({StudyInstanceUID:'tie',StudyDate:'20261115'})]);
  assert.deepEqual(model.studies.map(study=>study.uid),['new','tie','old','missing','invalid']);
});
test('conflicting supplied metadata is surfaced instead of selecting an invented value',()=>{
  const model=buildStudyModel([entry({StudyInstanceUID:'study',SeriesInstanceUID:'series',StudyDate:'20260101',InstitutionName:'One'}),
    entry({StudyInstanceUID:'study',SeriesInstanceUID:'series',StudyDate:'20261115',InstitutionName:'Two'})]);
  assert.equal(model.studies[0].dateLabel,'Multiple supplied dates');assert.equal(model.studies[0].facility,'Multiple supplied values');
  assert.deepEqual(model.studies[0].raw.facilities,['One','Two']);
});
test('labels do not infer anatomy, dates or institutions from source filenames',()=>{
  const study=buildStudyModel([entry({}, {sourcePath:'BRAIN_MRI_20260101_HOSPITAL.dcm'})]).studies[0];
  assert.equal(study.dateLabel,'Date not provided');assert.equal(study.bodyArea,'Body area not provided');assert.equal(study.facility,'Facility not provided');
  assert.equal(study.series[0].modalityLabel,'Image type not provided');assert.equal(modalityLabel('MR'),'MRI images');assert.equal(modalityLabel('PRIVATE'),'PRIVATE series');
});
test('thumbnail representatives prefer accepted raster previews without collapsing files',()=>{
  const common={StudyInstanceUID:'s',SeriesInstanceUID:'r'};
  const entries=[entry(common,{status:'unrendered',displayRejected:true}),entry(common),entry(common)];
  const series=buildStudyModel(entries).studies[0].series[0];assert.equal(series.thumbnailIndex,1);assert.equal(series.count,3);assert.deepEqual(series.indices,[0,1,2]);
});
test('frame totals use supplied valid counts and do not guess malformed frame counts',()=>{
  const common={StudyInstanceUID:'s',SeriesInstanceUID:'r'};
  let series=buildStudyModel([entry({...common,NumberOfFrames:'3'}),entry(common)]).studies[0].series[0];
  assert.equal(series.frameCount,4);assert.equal(series.imageCount,2);
  series=buildStudyModel([entry({...common,NumberOfFrames:'bad'}),entry(common)]).studies[0].series[0];assert.equal(series.frameCount,null);
});
test('source text remains literal, and nonprimitive metadata does not become a guessed label',()=>{
  const attack='<img src=x onerror="window.example=1">';
  const study=buildStudyModel([entry({StudyDescription:attack,InstitutionName:{name:'not a scalar'},BodyPartExamined:'\u0000CHEST'})]).studies[0];
  assert.equal(study.description,attack);assert.equal(study.facility,'Facility not provided');assert.equal(study.bodyArea,'CHEST');
});
test('non-image originals without a study ID stay separate from patient exams',()=>{
  const entries=[entry({StudyInstanceUID:'s',SeriesInstanceUID:'r'}),
    {sourcePath:'DICOMDIR',status:'unrendered',fields:{}},{sourcePath:'README.txt',status:'unrendered',fields:{}}];
  const model=buildStudyModel(entries);assert.equal(model.studies.length,1);assert.deepEqual(model.otherIndices,[1,2]);
  assert.equal(model.byIndex.size,3);assert.deepEqual(model.byIndex.get(1),{studyKey:null,seriesKey:null});
});
test('study-linked reports remain associated while representatives prefer an actual image',()=>{
  const fields={StudyInstanceUID:'s',SeriesInstanceUID:'r'};
  const model=buildStudyModel([{status:'unrendered',fields:{...fields,Modality:'SR'}},entry(fields)]);
  assert.equal(model.studies.length,1);assert.equal(model.studies[0].series[0].thumbnailIndex,1);assert.equal(model.studies[0].series[0].selectionIndex,1);
  const report=buildStudyModel([{status:'unrendered',fields:{...fields,Modality:'SR'}}]).studies[0].series[0];
  assert.equal(report.thumbnailIndex,null);assert.equal(report.selectionIndex,0);
});

test('pane filtering preserves original global indices while excluding supporting study-linked sources',()=>{
  const entries=[{attachment:'notes',sourcePath:'README.txt',fields:{StudyInstanceUID:'s'}},
    entry({StudyInstanceUID:'s',SeriesInstanceUID:'image'},{attachment:'image-a'}),
    {attachment:'directory',kind:'dicom-directory',fields:{StudyInstanceUID:'s'}},
    {attachment:'report',sourcePath:'report.dcm',fields:{StudyInstanceUID:'s',SeriesInstanceUID:'report',SOPClassUID:'1.2.840.10008.5.1.4.1.1.88.33',Modality:'SR'}},
    entry({StudyInstanceUID:'s',SeriesInstanceUID:'image'},{attachment:'image-b'})];
  const panes=buildPaneInventory(entries),model=buildStudyModel(entries,{includeEntry:(_entry,index)=>panes.byIndex.get(index).pane==='data'});
  assert.deepEqual([...model.byIndex.keys()],[1,3,4]);assert.deepEqual(model.excludedIndices,[0,2]);assert.deepEqual(model.otherIndices,[]);
  assert.equal(model.studies.length,1);assert.deepEqual(model.studies[0].indices,[1,3,4]);assert.equal(model.studies[0].count,3);
  assert.deepEqual(model.studies[0].series.find(series=>series.uid==='image').indices,[1,4]);assert.equal(model.studies[0].series.find(series=>series.uid==='report').selectionIndex,3);
});

test('filtered generic images and reports remain navigable without inferred study IDs or anatomy',()=>{
  const entries=[{attachment:'notes',sourcePath:'README.txt',fields:{}},{attachment:'pdf',sourcePath:'BRAIN_20260101.pdf',fields:{}},
    {attachment:'png',sourcePath:'CHEST_20260101.png',fields:{}}];
  const panes=buildPaneInventory(entries),model=buildStudyModel(entries,{includeEntry:(_entry,index)=>panes.byIndex.get(index).pane==='data'});
  assert.deepEqual([...model.byIndex.keys()],[1,2]);assert.equal(model.studies.length,2);assert.deepEqual(model.otherIndices,[]);
  for(const study of model.studies){assert.equal(study.uid,null);assert.equal(study.dateLabel,'Date not provided');assert.equal(study.bodyArea,'Body area not provided');}
  assert.deepEqual(model.studies.map(study=>study.series[0].selectionIndex),[1,2]);
});

class NavigationNode {
  constructor(ownerDocument,tag){this.ownerDocument=ownerDocument;this.tagName=tag;this.children=[];this.attributes=new Map();this.dataset={};this.listeners=new Map();this._text='';this.className='';this.replacements=0;
    this.classList={toggle:(name,force)=>{const names=new Set(this.className.split(' ').filter(Boolean));if(force)names.add(name);else names.delete(name);this.className=[...names].join(' ');}};
  }
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.replacements++;this._text='';this.children=[...children];}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  removeAttribute(key){this.attributes.delete(key);}
  getAttribute(key){return this.attributes.get(key)??null;}
  addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(handler);}
  dispatch(type,event={}){for(const handler of this.listeners.get(type)||[])handler({target:this,preventDefault(){},...event});}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  querySelectorAll(selector){const result=[];for(const child of this.children){if(selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.tagName===selector)result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
}
function navigationContainer(){const document={createElement:tag=>new NavigationNode(document,tag)};return new NavigationNode(document,'nav');}

test('filtered navigation selects global source indices, preserves same-series card DOM, and has no left Other button',()=>{
  const entries=[{attachment:'notes',sourcePath:'README.txt',fields:{}},entry({StudyInstanceUID:'s',SeriesInstanceUID:'series'},{attachment:'a'}),
    {attachment:'directory',kind:'dicom-directory',fields:{}},entry({StudyInstanceUID:'s',SeriesInstanceUID:'series'},{attachment:'b'})];
  const panes=buildPaneInventory(entries),container=navigationContainer(),selected=[];
  const navigation=createStudyNavigation({container,entries,includeEntry:(_entry,index)=>panes.byIndex.get(index).pane==='data',onSelect:index=>selected.push(index)});
  const card=container.querySelector('.series-card'),list=container.querySelector('.series-cards');assert.equal(card.dataset.sourceIndex,'1');
  card.dispatch('click');assert.deepEqual(selected,[1]);navigation.updateSelection(1);const replacements=list.replacements;
  navigation.updateSelection(3);assert.equal(container.querySelector('.series-card'),card);assert.equal(list.replacements,replacements);assert.equal(card.getAttribute('aria-current'),'true');
  assert.equal(container.querySelector('.other-supplied-files'),null);assert.ok(!container.textContent.includes('Other supplied files'));assert.ok(!container.textContent.includes('README'));
  assert.equal(entries[3].attachment,'b');navigation.destroy();assert.equal(container.hidden,true);
});

test('metadata-only inputs do not create navigation cards or a left-side Other disclosure',()=>{
  const entries=[{attachment:'notes',sourcePath:'README.txt',fields:{}},{attachment:'archive',kind:'zip-archive',fields:{}}],panes=buildPaneInventory(entries),container=navigationContainer();
  const navigation=createStudyNavigation({container,entries,includeEntry:(_entry,index)=>panes.byIndex.get(index).pane==='data'});
  assert.equal(container.hidden,true);assert.equal(container.querySelectorAll('.series-card').length,0);assert.equal(container.querySelector('.other-supplied-files'),null);
  assert.equal(container.querySelector('.study-picker-label').hidden,true);
  assert.deepEqual(navigation.model.excludedIndices,[0,1]);assert.equal(navigation.model.byIndex.size,0);navigation.destroy();
  assert.throws(()=>buildStudyModel(entries,{includeEntry:true}),TypeError);
});

test('one navigable exam hides the selector while series selection retains global source indices',()=>{
  const entries=[{attachment:'notes',sourcePath:'README.txt',fields:{StudyInstanceUID:'support-only'}},
    entry({StudyInstanceUID:'study',SeriesInstanceUID:'first',StudyDescription:'Synthetic study'},{attachment:'a'}),
    entry({StudyInstanceUID:'study',SeriesInstanceUID:'second'},{attachment:'b'}),
    {attachment:'directory',kind:'dicom-directory',fields:{StudyInstanceUID:'another-support-only'}},
    entry({StudyInstanceUID:'study',SeriesInstanceUID:'first'},{attachment:'c'})];
  const panes=buildPaneInventory(entries),container=navigationContainer(),selected=[];
  const navigation=createStudyNavigation({container,entries,includeEntry:(_entry,index)=>panes.byIndex.get(index).pane==='data',onSelect:index=>selected.push(index)});
  assert.equal(navigation.model.studies.length,1);assert.equal(container.hidden,false);
  assert.equal(container.querySelector('.study-picker-label').hidden,true);
  assert.equal(container.querySelectorAll('.series-card').length,2);
  assert.match(container.querySelector('.study-summary').textContent,/Synthetic study/);
  const cards=container.querySelectorAll('.series-card');cards[0].dispatch('click');cards[1].dispatch('click');
  assert.deepEqual(selected,[1,2]);navigation.updateSelection(4);
  assert.equal(container.querySelector('.study-picker-label').hidden,true);
  assert.equal(cards[0].getAttribute('aria-current'),'true');assert.equal(cards[0].dataset.sourceIndex,'1');
  assert.deepEqual([...navigation.model.byIndex.keys()],[1,2,4]);navigation.destroy();
});

test('multiple navigable exams show a working selector and track global selection in both directions',()=>{
  const entries=[{attachment:'notes',sourcePath:'README.txt',fields:{}},
    entry({StudyInstanceUID:'older',SeriesInstanceUID:'first',StudyDate:'20200101'},{attachment:'a'}),
    {attachment:'directory',kind:'dicom-directory',fields:{}},
    entry({StudyInstanceUID:'newer',SeriesInstanceUID:'second',StudyDate:'20260101'},{attachment:'b'}),
    entry({StudyInstanceUID:'older',SeriesInstanceUID:'first',StudyDate:'20200101'},{attachment:'c'}),
    {attachment:'photo',sourcePath:'photo.jpg',fields:{}}];
  const panes=buildPaneInventory(entries),container=navigationContainer(),selected=[];
  const navigation=createStudyNavigation({container,entries,includeEntry:(_entry,index)=>panes.byIndex.get(index).pane==='data',onSelect:index=>selected.push(index)});
  const heading=container.querySelector('.study-picker-label'),picker=container.querySelector('.study-picker');
  assert.equal(heading.hidden,false);assert.equal(picker.getAttribute('aria-label'),'Choose an exam');
  assert.equal(picker.children.length,4);assert.equal(container.querySelector('.series-card').dataset.sourceIndex,'3');
  const older=navigation.model.byIndex.get(1).studyKey,newer=navigation.model.byIndex.get(3).studyKey;
  picker.value=older;picker.dispatch('change');
  assert.deepEqual(selected,[1]);assert.equal(container.querySelector('.series-card').dataset.sourceIndex,'1');
  navigation.updateSelection(4);assert.equal(picker.value,older);assert.equal(container.querySelector('.series-card').getAttribute('aria-current'),'true');
  navigation.updateSelection(3);assert.equal(picker.value,newer);assert.equal(heading.hidden,false);
  assert.equal(container.querySelector('.series-card').dataset.sourceIndex,'3');
  picker.value=navigation.model.byIndex.get(5).studyKey;picker.dispatch('change');
  assert.deepEqual(selected,[1,5]);assert.equal(container.querySelector('.series-card').dataset.sourceIndex,'5');
  assert.equal(heading.hidden,false);navigation.destroy();
});

test('missing study IDs never expose an exam selector or prevent source selection without invented IDs',()=>{
  for(const count of [1,2]){
    const entries=Array.from({length:count},(_,index)=>entry({SeriesInstanceUID:'same-unproven-series'},{attachment:`source-${index}`}));
    const container=navigationContainer(),selected=[];
    const navigation=createStudyNavigation({container,entries,onSelect:index=>selected.push(index)});
    assert.equal(container.querySelector('.study-picker-label').hidden,true);
    assert.ok(navigation.model.studies.every(study=>study.uid===null));
    assert.equal(container.querySelectorAll('.series-card').length,1);
    if(count===2){
      const picker=container.querySelector('.study-picker');
      assert.match(picker.children[1].textContent,/Date not provided.*Body area not provided.*original 1/);
      assert.match(picker.children[2].textContent,/original 2/);
      navigation.updateSelection(1);
      assert.equal(picker.value,navigation.model.byIndex.get(1).studyKey);
      assert.equal(container.querySelector('.series-card').dataset.sourceIndex,'1');
      container.querySelector('.series-card').dispatch('click');assert.deepEqual(selected,[1]);
    }
    navigation.destroy();
  }
});

test('one supplied study plus unassigned JPEGs hides exam selection while retaining every data index',()=>{
  const entries=[{attachment:'photo-a',sourcePath:'photo-a.jpg',fields:{}},
    entry({StudyInstanceUID:'known',SeriesInstanceUID:'series'},{attachment:'dicom'}),
    {attachment:'notes',sourcePath:'README.txt',fields:{}},{attachment:'photo-b',sourcePath:'photo-b.jpeg',fields:{}}];
  const panes=buildPaneInventory(entries),container=navigationContainer(),selected=[];
  const navigation=createStudyNavigation({container,entries,includeEntry:(_entry,index)=>panes.byIndex.get(index).pane==='data',onSelect:index=>selected.push(index)});
  assert.equal(navigation.model.studies.length,3);
  assert.equal(navigation.model.studies.filter(study=>study.uid).length,1);
  assert.equal(container.querySelector('.study-picker-label').hidden,true);
  assert.deepEqual([...navigation.model.byIndex.keys()],[0,1,3]);
  for(const index of [1,3,0]){
    navigation.updateSelection(index);
    const card=container.querySelector('.series-card');assert.equal(card.dataset.sourceIndex,String(index));
    assert.equal(card.getAttribute('aria-current'),'true');card.dispatch('click');
    assert.equal(container.querySelector('.study-picker-label').hidden,true);
  }
  assert.deepEqual(selected,[1,3,0]);
  assert.ok(navigation.model.studies.filter(study=>!study.uid).every(study=>study.uid===null));
  navigation.destroy();
});
