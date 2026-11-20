import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkTrackballCamera from '@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkInteractor from '@kitware/vtk.js/Rendering/Core/RenderWindowInteractor';
import vtkOpenGLRenderWindow from '@kitware/vtk.js/Rendering/OpenGL/RenderWindow';

const COLORS=[[0.36,0.69,0.94],[0.96,0.62,0.34],[0.43,0.82,0.67],[0.79,0.60,0.91]];

export function renderSurfaceSegmentation(container,{surfaces}){
  const panel=document.createElement('section');
  panel.className='surface-segmentation';
  panel.setAttribute('aria-label','3D surface segmentation');
  const host=document.createElement('div');
  host.className='surface-segmentation-canvas';
  const controls=document.createElement('div');
  controls.className='image-controls surface-segmentation-controls';
  panel.append(host,controls);

  const view=vtkOpenGLRenderWindow.newInstance({cursor:'grab'});
  let context;
  try{
    context=view.get3DContext();
  }catch{
    view.delete();
    throw new Error('WebGL is unavailable in this browser. A WebGL context is required to view the 3D surface.');
  }
  const renderer=vtkRenderer.newInstance({background:[16/255,23/255,34/255]});
  const renderWindow=vtkRenderWindow.newInstance();
  const interactor=vtkInteractor.newInstance();
  const style=vtkTrackballCamera.newInstance();
  const objects=[];
  const observer=new ResizeObserver(resize);
  let fitted=false;

  function cleanup(){
    observer.disconnect();
    interactor.setInteractorStyle(null);
    interactor.delete();
    style.delete();
    if(view.getContext())view.releaseGraphicsResources();
    for(const {actor,mapper,mesh,normals} of objects){
      renderer.removeActor(actor);
      actor.delete();
      mapper.delete();
      mesh.delete();
      normals?.delete();
    }
    renderWindow.removeView(view);
    renderWindow.removeRenderer(renderer);
    view.delete();
    context.getExtension('WEBGL_lose_context')?.loseContext();
    renderWindow.delete();
    renderer.delete();
    panel.remove();
  }

  function fit(){
    const camera=renderer.getActiveCamera();
    camera.setFocalPoint(0,0,0);
    camera.setPosition(1,-1,0.6);
    camera.setViewUp(0,0,1);
    camera.orthogonalizeViewUp();
    renderer.resetCamera();
    fitted=true;
  }

  function resize(){
    const {width,height}=host.getBoundingClientRect();
    if(width<1||height<1)return;
    const ratio=Math.min(window.devicePixelRatio||1,2);
    view.setSize(Math.floor(width*ratio),Math.floor(height*ratio));
    if(!fitted)fit();
    renderWindow.render();
  }

  function button(label,adjust){
    const element=document.createElement('button');
    element.type='button';
    element.textContent=label;
    element.addEventListener('click',()=>{
      const camera=renderer.getActiveCamera();
      adjust(camera);
      camera.orthogonalizeViewUp();
      renderer.resetCameraClippingRange();
      renderWindow.render();
    });
    controls.append(element);
  }

  try{
    renderWindow.addRenderer(renderer);
    renderWindow.addView(view);
    view.setContainer(host);
    interactor.setInteractorStyle(style);
    interactor.setView(view);
    for(const [index,surface] of surfaces.entries()){
      const mesh=vtkPolyData.newInstance();
      const mapper=vtkMapper.newInstance({scalarVisibility:false});
      const actor=vtkActor.newInstance();
      const normals=surface.normals?vtkDataArray.newInstance({
        name:'Normals',numberOfComponents:3,values:surface.normals,
      }):null;
      objects.push({actor,mapper,mesh,normals});
      mesh.getPoints().setData(surface.points,3);
      mesh.getPolys().setData(surface.triangles);
      mesh.getLines().setData(surface.lines);
      mesh.getVerts().setData(surface.vertices);
      if(normals)mesh.getPointData().setNormals(normals);
      mapper.setInputData(mesh);
      actor.setMapper(mapper);
      const property=actor.getProperty();
      property.setColor(...COLORS[index%COLORS.length]);
      // Some legacy objects recommend zero opacity. Keep them visible in this standalone preview.
      property.setOpacity(surface.opacity>0?surface.opacity:1);
      property.setPointSize(4);
      if(surface.presentation==='WIREFRAME')property.setRepresentationToWireframe();
      if(surface.presentation==='POINTS')property.setRepresentationToPoints();
      renderer.addActor(actor);
    }
    if(surfaces.length>1){
      const label=document.createElement('label');
      label.textContent='Surface';
      const select=document.createElement('select');
      select.add(new Option('All surfaces',''));
      for(const {number,label:name} of surfaces)select.add(new Option(`${number} · ${name}`,String(number)));
      select.addEventListener('change',()=>{
        for(const [index,{actor}] of objects.entries()){
          actor.setVisibility(!select.value||select.value===String(surfaces[index].number));
        }
        fit();
        renderWindow.render();
      });
      label.append(select);
      controls.append(label);
    }
    button('Rotate left',camera=>camera.azimuth(-15));
    button('Rotate right',camera=>camera.azimuth(15));
    button('Rotate up',camera=>camera.elevation(15));
    button('Rotate down',camera=>camera.elevation(-15));
    button('Zoom in',camera=>camera.dolly(1.25));
    button('Zoom out',camera=>camera.dolly(0.8));
    button('Reset view',fit);
    const hint=document.createElement('span');
    hint.className='gesture-hint';
    hint.textContent='Drag to rotate. Shift + drag to pan. Scroll to zoom.';
    controls.append(hint);
    container.append(panel);
    resize();
    interactor.initialize();
    interactor.bindEvents(host);
    observer.observe(host);
    return cleanup;
  }catch(error){
    cleanup();
    throw error;
  }
}
