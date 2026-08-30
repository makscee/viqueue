const contextKey=Symbol.for('viq.worker.session-rotation-context');

export function rememberRotationContext(ctx){globalThis[contextKey]=ctx}
export function clearRotationContext(ctx){if(globalThis[contextKey]===ctx)delete globalThis[contextKey]}
export async function rotateToFreshSession(){const ctx=globalThis[contextKey];if(!ctx||typeof ctx.newSession!=='function'||typeof ctx.waitForIdle!=='function')throw new Error('viq_rotation_context_unavailable');await ctx.waitForIdle();const parentSession=ctx.sessionManager.getSessionFile();const result=await ctx.newSession({parentSession,withSession:async freshCtx=>{rememberRotationContext(freshCtx)}});if(result?.cancelled)throw new Error('viq_rotation_cancelled');return result}
