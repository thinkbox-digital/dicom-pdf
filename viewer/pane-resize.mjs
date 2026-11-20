/** Pane geometry only; preferences live in memory and contain no study data. */
export function paneResizeLimits({side,width,other=0,narrow=false}){
  const minimum=side==='navigation'?(narrow?120:180):(narrow?200:240);
  const available=narrow&&side==='details'?width-24:width-(narrow?180:320)-other-8;
  const max=Math.max(0,Math.min(640,available));
  return {min:Math.min(minimum,max),max};
}
export function resizedPaneWidth(start,delta,side,limits){
  return Math.round(Math.max(limits.min,Math.min(limits.max,start+(side==='navigation'?delta:-delta))));
}

export function bindPaneResizing({root=document,onCommit=()=>{}}={}){
  const workspace=root.getElementById('workspace');
  if(!workspace)return {refresh(){}};
  const panels={navigation:workspace.querySelector('.source-panel'),details:root.getElementById('details-panel')};
  const wanted={navigation:null,details:null},handles={},view=root.defaultView||window;
  let drag=null,scheduled=false,finished=false;
  const narrow=()=>view.matchMedia('(max-width:850px)').matches;
  const visible=side=>panels[side]&&!panels[side].hidden&&view.getComputedStyle(panels[side]).display!=='none';
  const limits=side=>paneResizeLimits({side,width:workspace.clientWidth,narrow:narrow(),other:narrow()?0:
    visible(side==='navigation'?'details':'navigation')?panels[side==='navigation'?'details':'navigation'].getBoundingClientRect().width:0});
  const property=side=>side==='navigation'?'--navigation-size':'--details-size';
  const width=side=>panels[side].getBoundingClientRect().width;
  function refresh(){
    if(finished)return;
    for(const side of ['navigation','details']){
      const handle=handles[side];if(!handle)continue;
      handle.hidden=!visible(side);
      if(handle.hidden)continue;
      const bounds=limits(side);
      if(wanted[side]!==null)workspace.style.setProperty(property(side),`${resizedPaneWidth(wanted[side],0,side,bounds)}px`);
      const pane=panels[side].getBoundingClientRect(),box=workspace.getBoundingClientRect();
      handle.style.left=`${(side==='navigation'?pane.right:pane.left)-box.left-4}px`;
      handle.setAttribute('aria-valuemin',String(Math.round(bounds.min)));handle.setAttribute('aria-valuemax',String(Math.round(bounds.max)));
      handle.setAttribute('aria-valuenow',String(Math.round(pane.width)));handle.setAttribute('aria-valuetext',`${Math.round(pane.width)} pixels`);
    }
  }
  function queue(){if(scheduled||finished)return;scheduled=true;view.requestAnimationFrame(()=>{scheduled=false;refresh();});}
  const change=(side,value)=>{wanted[side]=value;refresh();};
  function reset(side){wanted[side]=null;workspace.style.removeProperty(property(side));refresh();onCommit();}
  function end(event){
    if(!drag||event.pointerId!==drag.pointerId)return;
    const current=drag;drag=null;workspace.classList.remove('resizing-panes');
    if(current.handle.hasPointerCapture?.(current.pointerId))current.handle.releasePointerCapture(current.pointerId);
    refresh();onCommit();
  }
  for(const side of ['navigation','details']){
    const panel=panels[side];if(!panel)continue;
    if(!panel.id)panel.id='data-panel';
    const handle=root.createElement('div');handles[side]=handle;
    handle.id=`resize-${side}`;handle.className='pane-resize-handle';handle.tabIndex=0;
    handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-controls',panel.id);
    handle.setAttribute('aria-label',side==='navigation'?'Resize data pane':'Resize metadata pane');
    handle.title='Drag to resize. Arrow keys move the divider; Shift moves faster. Home/End set the limits. Double-click or Enter resets the width.';
    workspace.append(handle);
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0||!visible(side))return;
      event.preventDefault();handle.focus({preventScroll:true});
      drag={side,start:width(side),x:event.clientX,pointerId:event.pointerId,handle};
      handle.setPointerCapture(event.pointerId);workspace.classList.add('resizing-panes');
    });
    handle.addEventListener('pointermove',event=>{
      if(!drag||drag.handle!==handle||event.pointerId!==drag.pointerId)return;
      const value=resizedPaneWidth(drag.start,event.clientX-drag.x,side,limits(side));wanted[side]=value;queue();
    });
    handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);handle.addEventListener('lostpointercapture',end);
    handle.addEventListener('dblclick',()=>reset(side));
    handle.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
      const bounds=limits(side),step=event.shiftKey?40:10;
      if(event.key==='Enter'){event.preventDefault();reset(side);return;}
      const value=event.key==='Home'?bounds.min:event.key==='End'?bounds.max:
        event.key==='ArrowLeft'?resizedPaneWidth(width(side),-step,side,bounds):event.key==='ArrowRight'?resizedPaneWidth(width(side),step,side,bounds):null;
      if(value===null)return;event.preventDefault();change(side,value);onCommit();
    });
  }
  const observer=new view.ResizeObserver(queue);observer.observe(workspace);
  for(const panel of Object.values(panels))if(panel)observer.observe(panel);
  const visibility=new view.MutationObserver(queue);visibility.observe(workspace,{attributes:true,attributeFilter:['class']});
  for(const panel of Object.values(panels))if(panel)visibility.observe(panel,{attributes:true,attributeFilter:['hidden']});
  refresh();
  return {refresh,destroy(){finished=true;observer.disconnect();visibility.disconnect();drag=null;workspace.classList.remove('resizing-panes');Object.values(handles).forEach(h=>h.remove());}};
}
