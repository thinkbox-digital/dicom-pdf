/** A superseded input cannot update or dismiss the current input's loading UI. */
export function createLoadingDialog(dialog){
  const message=dialog.querySelector('[role="status"]');let owner=null;
  dialog.addEventListener('cancel',event=>event.preventDefault());
  function reset(){owner=null;if(dialog.open)dialog.close();}
  return {
    reset,
    start(request,text){owner=request;message.textContent=text;if(!dialog.open)dialog.showModal();},
    update(request,text){if(owner===request)message.textContent=text;},
    finish(request){if(owner===request)reset();}
  };
}
