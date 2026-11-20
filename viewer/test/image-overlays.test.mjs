import test from 'node:test';
import assert from 'node:assert/strict';
import {imageOverlayContext,orientationMarkers,sourceContextLines} from '../image-overlays.mjs';

const axial={iop:[1,0,0,0,1,0],anatomicalOrientationType:null,provenance:'top-level'};
const none={top:null,right:null,bottom:null,left:null};
const decoded={image:{color:false},frameCount:12,sourceFrame:2,sourceOrientation:axial};

test('source context shares supplied-only formatting without exposing patient identity fields',()=>{
  const entry={navigationFields:{SeriesDescription:'Fallback',StudyDate:'20261115'},
    fields:{SeriesDescription:'Synthetic\u202e <script>literal</script>',SeriesNumber:'03',PatientName:'Do not display',PatientID:'Do not display'}};
  assert.deepEqual(sourceContextLines(entry),['Series 03 · Synthetic <script>literal</script>','Study 15 Nov 2026']);
  assert.deepEqual(sourceContextLines({fields:{StudyDate:'20260230',SeriesNumber:'not a number'}}),[]);
});

test('supplied series/date, actual image/frame position and live window/zoom have compact text',()=>{
  const result=imageOverlayContext({entry:{fields:{SeriesNumber:'03',SeriesDescription:'Synthetic series',StudyDate:'20261115'}},decoded,
    index:4,count:101,frame:7,window:{center:-12.123456,width:400.654321},zoom:1.234567});
  assert.deepEqual(result.lines,{topLeft:['Series 03 · Synthetic series','Study 15 Nov 2026'],bottomLeft:['Image 5 of 101','Frame 7 of 12'],bottomRight:['WL -12.123 · WW 400.654','Zoom 123.457%']});
  assert.deepEqual(result.markers,{top:'A',right:'L',bottom:'P',left:'R'});
});

test('cardinal clockwise rotations follow screen edges, including negative and full turns',()=>{
  const expected=[{top:'A',right:'L',bottom:'P',left:'R'},{top:'R',right:'A',bottom:'L',left:'P'},
    {top:'P',right:'R',bottom:'A',left:'L'},{top:'L',right:'P',bottom:'R',left:'A'}];
  for(let turns=-4;turns<=4;turns++)assert.deepEqual(orientationMarkers(axial,{rotation:turns*90}),expected[(turns%4+4)%4]);
});

test('source axes give actual sagittal/coronal head/feet markers and oblique combined directions',()=>{
  assert.deepEqual(orientationMarkers({...axial,iop:[0,1,0,0,0,-1]}),{top:'H',right:'P',bottom:'F',left:'A'});
  assert.deepEqual(orientationMarkers({...axial,iop:[1,0,0,0,0,-1]}),{top:'H',right:'L',bottom:'F',left:'R'});
  const angle=Math.PI/6;
  assert.deepEqual(orientationMarkers({...axial,iop:[Math.cos(angle),Math.sin(angle),0,-Math.sin(angle),Math.cos(angle),0]}),
    {top:'AL',right:'LP',bottom:'PR',left:'RA'});
});

test('explicit biped and absent anatomical type are allowed but quadruped or unknown types are hidden',()=>{
  for(const type of [null,undefined,'BIPED',' BIPED '])assert.equal(orientationMarkers({...axial,anatomicalOrientationType:type}).right,'L');
  for(const type of ['QUADRUPED','UNKNOWN','',{},12])assert.deepEqual(orientationMarkers({...axial,anatomicalOrientationType:type}),none);
});

test('requires source provenance and does not trust renderer/default or manifest fallback geometry',()=>{
  for(const provenance of [null,undefined,'renderer-default','manifest',''])assert.deepEqual(orientationMarkers({...axial,provenance}),none);
  for(const provenance of ['top-level','shared-functional-groups','per-frame-functional-groups'])assert.equal(orientationMarkers({...axial,provenance}).top,'A');
  const result=imageOverlayContext({entry:{fields:{ImageOrientationPatient:'1\\0\\0\\0\\1\\0'}},
    decoded:{metadata:{imagePlaneModule:{rowCosines:[1,0,0],columnCosines:[0,1,0],usingDefaultValues:false}}}});
  assert.deepEqual(result.markers,none);
});

test('missing, malformed and non-orthonormal source vectors never produce orientation labels',()=>{
  for(const iop of [null,[],[1,0,0,0,1],[1,0,0,0,1,NaN],[1,0,0,0,1,Infinity],[0,0,0,0,1,0],
    [1,0,0,1,0,0],[2,0,0,0,1,0],[1,0,0,0.01,1,0],['1',0,0,0,1,0],'1\\0\\0\\0\\1\\','0x1\\0\\0\\0\\1\\0'])assert.deepEqual(orientationMarkers({...axial,iop}),none);
  assert.deepEqual(orientationMarkers(null),none);
  for(const rotation of [NaN,Infinity,'90',1e30])assert.deepEqual(orientationMarkers(axial,{rotation}),none);
});

test('rounded orthonormal DS vectors are accepted and orientation arrays remain unchanged',()=>{
  const iop=[0.707107,0.707107,0,-0.707107,0.707107,0],snapshot=[...iop];
  assert.equal(orientationMarkers({...axial,iop}).right,'LP');assert.deepEqual(iop,snapshot);
  assert.deepEqual(orientationMarkers({...axial,iop:'1\\0\\0\\0\\1\\0'}),orientationMarkers(axial));
});

test('explicit selected-frame orientation wins and explicit null prevents fallback',()=>{
  assert.equal(imageOverlayContext({decoded}).markers.right,'L');
  const perFrame={...axial,iop:[0,1,0,0,0,-1],provenance:'per-frame-functional-groups'};
  assert.equal(imageOverlayContext({decoded,sourceOrientation:perFrame}).markers.right,'P');
  assert.deepEqual(imageOverlayContext({decoded,sourceOrientation:null}).markers,none);
});

test('non-square source-pixel zoom scales display both axes while approximately equal scales stay compact',()=>{
  assert.deepEqual(imageOverlayContext({zoom:{x:2,y:1}}).lines.bottomRight,['Zoom 200% × 100%']);
  assert.deepEqual(imageOverlayContext({zoom:{x:1,y:1.0000001}}).lines.bottomRight,['Zoom 100%']);
  assert.deepEqual(imageOverlayContext({zoom:{x:0.123456,y:0.246913}}).lines.bottomRight,['Zoom 12.346% × 24.691%']);
});

test('invalid display values are omitted instead of invented or rounded into zero widths/scales',()=>{
  for(const zoom of [0,-1,NaN,Infinity,'1',1e20,1e-20,{x:1,y:0},{x:1},{x:NaN,y:2},null])assert.deepEqual(imageOverlayContext({zoom}).lines.bottomRight,[]);
  for(const window of [{center:1,width:0},{center:1,width:-2},{center:NaN,width:2},{center:1e30,width:2},{center:'2',width:4},{center:1,width:0.000001},null])
    assert.deepEqual(imageOverlayContext({decoded,window}).lines.bottomRight,[]);
  assert.deepEqual(imageOverlayContext({decoded,window:{center:-0.0000001,width:1}}).lines.bottomRight,['WL 0 · WW 1']);
});

test('color images do not show irrelevant grayscale window values',()=>{
  assert.deepEqual(imageOverlayContext({decoded:{...decoded,image:{color:true}},window:{center:50,width:100},zoom:1}).lines.bottomRight,['Zoom 100%']);
  assert.deepEqual(imageOverlayContext({window:{center:50,width:100}}).lines.bottomRight,[]);
});

test('image/frame positions reject invalid bounds and show multiframe source position only when known',()=>{
  for(const [index,count] of [[-1,2],[2,2],[0,0],[1.5,2],[0,NaN],[0,'invalid']])assert.deepEqual(imageOverlayContext({index,count}).lines.bottomLeft,[]);
  for(const frame of [0,13,1.5,NaN])assert.deepEqual(imageOverlayContext({decoded,frame}).lines.bottomLeft,[]);
  assert.deepEqual(imageOverlayContext({decoded}).lines.bottomLeft,['Frame 2 of 12']);
  assert.deepEqual(imageOverlayContext({decoded:{image:{color:false},frameCount:1,sourceFrame:1},index:0,count:1}).lines.bottomLeft,['Image 1 of 1']);
  assert.deepEqual(imageOverlayContext({entry:{fields:{NumberOfFrames:'184'}},frame:184}).lines.bottomLeft,['Frame 184 of 184']);
});

test('overlays use only actual series/study date fields and never identifiers or filename guesses',()=>{
  const entry={sourcePath:'CHEST_20261115_PATIENT.dcm',sopInstanceUID:'secret-instance',fields:{PatientName:'secret-name',PatientID:'secret-id',
    PatientBirthDate:'19900101',StudyInstanceUID:'secret-study',SeriesInstanceUID:'secret-series',AccessionNumber:'secret-accession'}};
  const result=imageOverlayContext({entry});assert.deepEqual(result.lines,{topLeft:[],bottomLeft:[],bottomRight:[]});
  assert.ok(!JSON.stringify(result).includes('secret'));assert.deepEqual(result.markers,none);
  for(const StudyDate of ['20260230','2026','2026-11-15','',null])assert.deepEqual(imageOverlayContext({entry:{fields:{StudyDate}}}).lines.topLeft,[]);
});

test('selected source fields take precedence and text is bounded, single-line and inert',()=>{
  const result=imageOverlayContext({entry:{navigationFields:{SeriesDescription:'Wrong',StudyDate:'20200101'},fields:{SeriesDescription:'<script>\nwindow.bad=true</script>\u202e'+'😀'.repeat(100),StudyDate:'20261115',SeriesNumber:{bad:true}}}});
  assert.equal(result.lines.topLeft.length,2);assert.match(result.lines.topLeft[0],/^<script> window.bad=true<\/script>/);
  assert.equal([...result.lines.topLeft[0]].length,80);assert.ok(result.lines.topLeft[0].endsWith('…'));assert.ok(!/[\r\n\u202e]/.test(result.lines.topLeft[0]));
  assert.equal(result.lines.topLeft[1],'Study 15 Nov 2026');
  assert.deepEqual(imageOverlayContext({entry:{fields:{SeriesNumber:'3.5'}}}).lines.topLeft,[]);
});
