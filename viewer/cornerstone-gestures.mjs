import {init,addTool,PanTool,ZoomTool,StackScrollTool,ToolGroupManager,Enums} from '@cornerstonejs/tools';

let initialized=false,sequence=0;
export function initializeGestures(){
  if(initialized)return;
  init();addTool(PanTool);addTool(ZoomTool);addTool(StackScrollTool);initialized=true;
}

/** Standard mouse/touch tools; application ownership is limited to readiness/lifecycle. */
export function bindCornerstoneGestures({element,viewport,engine,ready,scrollReady=null}){
  initializeGestures();
  const id=`dicom-gestures-${++sequence}`,group=ToolGroupManager.createToolGroup(id);
  group.addTool(PanTool.toolName);group.addTool(ZoomTool.toolName,{zoomToCenter:true});
  if(scrollReady)group.addTool(StackScrollTool.toolName,{debounceIfNotLoaded:false,loop:false});
  group.addViewport(viewport.id,engine.id);
  let active=false;
  const cancel=()=>{group.setToolDisabled(PanTool.toolName);group.setToolDisabled(ZoomTool.toolName);active=false;};
  const begin=event=>{
    if(!ready()){cancel();event.stopImmediatePropagation();return;}
    element.focus({preventScroll:true});
    if(active)return;
    group.setToolActive(PanTool.toolName,{bindings:[{mouseButton:Enums.MouseBindings.Primary},{numTouchPoints:1}]});
    group.setToolActive(ZoomTool.toolName,{bindings:[{mouseButton:Enums.MouseBindings.Secondary},{numTouchPoints:2}]});active=true;
  };
  const menu=event=>{if(ready())event.preventDefault();};
  const wheel=event=>{
    if(!scrollReady)return;
    if(scrollReady(event))group.setToolActive(StackScrollTool.toolName,{bindings:[{mouseButton:Enums.MouseBindings.Wheel}]});
    else group.setToolDisabled(StackScrollTool.toolName);
  };
  element.addEventListener('mousedown',begin,true);element.addEventListener('touchstart',begin,{capture:true,passive:true});
  element.addEventListener('contextmenu',menu);
  if(scrollReady)element.addEventListener('wheel',wheel,{capture:true,passive:true});
  return {cancel,destroy(){cancel();element.removeEventListener('mousedown',begin,true);element.removeEventListener('touchstart',begin,true);
    element.removeEventListener('contextmenu',menu);element.removeEventListener('wheel',wheel,true);ToolGroupManager.destroyToolGroup(id);}};
}
