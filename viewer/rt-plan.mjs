import {readDicomText} from './metadata-export.mjs';

export const RT_PLAN_SOP='1.2.840.10008.5.1.4.1.1.481.5';

function items(ds,tag){return (ds.elements[tag]?.items||[]).map(item=>item.dataSet).filter(Boolean);}

export function rtReferenceUids(ds,tag){
  return items(ds,tag).map(item=>readDicomText(item,'x00081155')).filter(Boolean);
}

function attributes(ds,tags,characterSet){
  return tags.map(([tag,label])=>[label,readDicomText(ds,'x'+tag,characterSet)]).filter(([,value])=>value!==null);
}

function referenceFields(ds,tag,label){
  return rtReferenceUids(ds,tag).map(instance=>[label,instance]);
}

function numbered(ds,tag,label,fields){
  const number=readDicomText(ds,tag);
  return {title:number?label+' '+number:label,fields};
}

/** Read a subset of the recorded plan attributes without deriving treatment parameters. */
export function readRtPlan(ds){
  const characterSet=readDicomText(ds,'x00080005')||'';
  const fields=[
    ...attributes(ds,[
      ['300a0002','Plan label'],['300a0003','Plan name'],['300a0004','Description'],
      ['300a0006','Plan date'],['300a0007','Plan time'],['300a000a','Plan intent'],
      ['300a000c','Plan geometry'],['30100077','Treatment site'],['300e0002','Recorded approval status'],
    ],characterSet),
    ...referenceFields(ds,'x300c0060','Referenced structure set UID'),
    ...referenceFields(ds,'x300c0080','Referenced dose UID'),
    ...referenceFields(ds,'x300c0002','Referenced plan UID'),
  ];
  const fractionGroups=items(ds,'x300a0070').map(group=>{
    const groupCharacterSet=readDicomText(group,'x00080005')||characterSet;
    const beams=items(group,'x300c0004').flatMap(beam=>{
      const number=readDicomText(beam,'x300c0006'),label=number?'Beam '+number:'Referenced beam';
      return [
        ...(number?[['Referenced beam number',number]]:[]),
        ...attributes(beam,[['300a0084',label+' dose per fraction (Gy)'],['300a0086',label+' meterset']],groupCharacterSet),
      ];
    });
    const setups=items(group,'x300c000a').flatMap(setup=>attributes(setup,[
      ['300c000c','Referenced brachy application setup number'],
    ],groupCharacterSet));
    return numbered(group,'x300a0071','Fraction group',[
      ...attributes(group,[
        ['300a0072','Description'],['300a0078','Fractions planned'],['300a0080','Number of beams'],
        ['300a00a0','Number of brachy application setups'],['300a008b','Beam dose meaning'],
      ],characterSet),
      ...beams,...setups,...referenceFields(group,'x300c0080','Referenced dose UID'),
    ]);
  });
  const beams=items(ds,'x300a00b0').map(beam=>{
    const initial=items(beam,'x300a0111')[0];
    const beamCharacterSet=readDicomText(beam,'x00080005')||characterSet;
    // Show only values explicitly recorded at control point zero.
    const start=initial&&/^\+?0+$/.test(readDicomText(initial,'x300a0112')||'')?attributes(initial,[
      ['300a011e','Initial gantry angle (°)'],['300a0120','Initial beam-limiting device angle (°)'],
      ['300a0122','Initial patient support angle (°)'],['300a0114','Initial nominal beam energy'],
    ],beamCharacterSet):[];
    return numbered(beam,'x300a00c0','Beam',[
      ...attributes(beam,[
        ['300a00c2','Name'],['300a00c3','Description'],['300a00c4','Beam type'],['300a00c6','Radiation type'],
        ['300a00ce','Treatment delivery type'],['300a00b2','Treatment machine'],
        ['300a00b3','Primary dosimeter unit'],['300a0110','Number of control points'],
      ],characterSet),
      ...start,
    ]);
  });
  const brachy=items(ds,'x300a0230').map(setup=>numbered(setup,'x300a0234','Application setup',attributes(setup,[
    ['300a0232','Type'],['300a0236','Name'],['300a0238','Manufacturer'],
    ['300a0250','Total reference air kerma'],
  ],characterSet)));
  const doses=items(ds,'x300a0010').map(dose=>numbered(dose,'x300a0012','Dose reference',attributes(dose,[
    ['300a0016','Description'],['300a0020','Type'],['300a0014','Structure type'],['300a0026','Target prescription dose (Gy)'],
    ['300a0027','Target maximum dose (Gy)'],['300a002c','Organ at risk maximum dose (Gy)'],
  ],characterSet)));
  const sections=[
    {title:'Fraction groups',items:fractionGroups},
    {title:'Beams',items:beams},
    {title:'Brachytherapy application setups',items:brachy},
    {title:'Dose references',items:doses},
  ].filter(section=>section.items.length);
  if(!fields.length&&!sections.length)throw new Error('The RT Plan has no readable summary fields.');
  return {fields,sections};
}
