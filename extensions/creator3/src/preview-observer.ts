/** 固定只读脚本：跟踪原生场景对象和绘制事件，不导入第二份引擎、不读取私有暂停字段。 */
export class PreviewObserver {
  source(): string {
    return `const key='__cocosMcpPreviewObservation';
      let state=globalThis[key];
      if(!state || state.director!==cc.director){
        state?.dispose();
        state={director:cc.director,scene:null,generation:0,frameIndex:0,sceneFrameIndex:0,lastFrameAt:null};
        state.sync=()=>{const scene=cc.director.getScene();if(scene!==state.scene){state.scene=scene;state.generation++;state.sceneFrameIndex=0;}};
        state.draw=()=>{state.sync();state.frameIndex++;state.sceneFrameIndex++;state.lastFrameAt=new Date().toISOString();};
        state.sync();
        cc.director.on(cc.Director.EVENT_AFTER_DRAW,state.draw);
        const launch=cc.Director.EVENT_AFTER_SCENE_LAUNCH;
        if(launch)cc.director.on(launch,state.sync);
        state.dispose=()=>{cc.director.off(cc.Director.EVENT_AFTER_DRAW,state.draw);if(launch)cc.director.off(launch,state.sync);delete globalThis[key];};
        globalThis[key]=state;
      }
      state.sync();
      const paused=target=>{try{return typeof target?.isPaused==='function'?target.isPaused():null;}catch{return null;}};
      const size=method=>{try{const value=cc.view?.[method]?.();return value?{width:value.width,height:value.height}:null;}catch{return null;}};
      const viewport=()=>{try{const r=cc.view?.getViewportRect?.();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null;}catch{return null;}};
      const scale=()=>{try{const x=cc.view?.getScaleX?.(),y=cc.view?.getScaleY?.();return x>0&&y>0?{x,y}:null;}catch{return null;}};
      const read=()=>{state.sync();const canvas=cc.game?.canvas;const rect=canvas?.getBoundingClientRect?.();return {
        ready:!!state.scene,sceneId:state.scene?.uuid??null,sceneGeneration:state.generation,runtimeInstanceId:globalThis.__cocosMcpDevelopmentConnection?.instanceId??null,
        frameIndex:state.frameIndex,sceneFrameIndex:state.sceneFrameIndex,lastFrameAt:state.lastFrameAt,gamePaused:paused(cc.game),directorPaused:paused(cc.director),
        visibility:typeof document==='undefined'?null:document.visibilityState,focused:typeof document==='undefined'?null:document.hasFocus(),
        canvasRect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,
        canvasPixelSize:canvas?{width:canvas.width,height:canvas.height}:null,
        designResolution:size('getDesignResolutionSize'),frameSize:size('getFrameSize'),
        engineViewportRect:viewport(),engineScale:scale(),
        devicePixelRatio:typeof devicePixelRatio==='number'?devicePixelRatio:null,
        resolutionPolicy:null
      };};`;
  }
}
