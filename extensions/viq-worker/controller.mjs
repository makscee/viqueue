// Process-local controller facts only; adapters are generation-fenced and never contain model data.
export const controller={epoch:0,adapter:null,persistent:false,pendingStart:false,rotating:false,runtime:null};
export function attach(adapter){const epoch=++controller.epoch;controller.adapter={...adapter,epoch,transition:null};return epoch}
export function detach(epoch){if(controller.adapter?.epoch===epoch)controller.adapter=null}
export function current(epoch){return controller.adapter?.epoch===epoch?controller.adapter:null}
export function captureTransition(ctx){if(controller.adapter)controller.adapter.transition=ctx}
export function clearTransition(epoch){const adapter=current(epoch);if(adapter)adapter.transition=null}
