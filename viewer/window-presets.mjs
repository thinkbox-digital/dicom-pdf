import {validWindow,normalizeWindow} from './voi-window.mjs';

const MAX_PRESETS=256,MAX_LABEL=80;
const EMPTY=Object.freeze({options:Object.freeze([]),selected:'initial',window:null,hidden:true});
const sameWindow=(a,b)=>a.center===b.center&&a.width===b.width&&a.function===b.function;

function bounded(value,limit=MAX_LABEL){
  if(typeof value!=='string')return '';
  const text=value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim(),result=[];
  for(const character of text){if(result.length===limit)return result.slice(0,limit-1).join('')+'…';result.push(character);}
  return result.join('');
}
function number(value){
  const magnitude=Math.abs(value);
  if(value!==0&&(magnitude<0.001||magnitude>=1e9))return value.toExponential(3).replace(/\.?0+e/,'e');
  const rounded=Number(value.toFixed(3));return String(Object.is(rounded,-0)?0:rounded);
}
function label(preset,window){
  const supplied=bounded(preset.label),name=supplied||`Source preset ${preset.index+1}`;
  const suffix=` · WL ${number(window.center)} / WW ${number(window.width)}${window.function==='LINEAR'?'':` · ${window.function}`}`;
  const budget=Math.max(1,MAX_LABEL-[...suffix].length);
  return bounded(name,budget)+suffix;
}

/**
 * Source-only display choices. Keys keep the original WC/WW multiplicity index
 * so a selected source:N can resolve to the selected frame's own exact values.
 * The initial option is the decoder's effective display, including PDF recipes;
 * no anatomy defaults, contrast adjustments or source mutations are added here.
 * Caller resets manual brightness/contrast after choosing a new baseline window.
 */
export function buildWindowPresets(decoded,{selected='initial'}={}){
  const image=decoded?.image;
  const initial={center:image?.windowCenter,width:image?.windowWidth,function:image?.color===true?'LINEAR':image?.voiLUTFunction??'LINEAR'};
  if(!validWindow(initial))return EMPTY;
  const initialWindow=normalizeWindow(initial),options=[Object.freeze({value:'initial',label:'Initial display',window:initialWindow})];
  const presets=decoded?.sourceWindowPresets?.presets;
  if(image.color!==true&&!image.sampledVoiLut&&Array.isArray(presets)&&presets.length<=MAX_PRESETS){
    const counts=new Map();
    for(const preset of presets)if(Number.isSafeInteger(preset?.index)&&preset.index>=0&&preset.index<MAX_PRESETS)counts.set(preset.index,(counts.get(preset.index)||0)+1);
    const valid=presets.filter(preset=>Number.isSafeInteger(preset?.index)&&preset.index>=0&&preset.index<MAX_PRESETS
      &&counts.get(preset.index)===1&&validWindow(preset)).sort((a,b)=>a.index-b.index);
    for(const preset of valid){
      const window=normalizeWindow(preset);
      options.push(Object.freeze({value:`source:${preset.index}`,label:label(preset,window),window}));
    }
  }
  const choice=options.find(option=>option.value===selected)||options[0];
  return Object.freeze({options:Object.freeze(options),selected:choice.value,window:choice.window,
    hidden:image.color===true||!options.slice(1).some(option=>!sameWindow(option.window,initialWindow))});
}
