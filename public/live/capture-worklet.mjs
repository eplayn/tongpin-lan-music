class Capture extends AudioWorkletProcessor {
  constructor(options){super();const ms=[20,40].includes(options?.processorOptions?.chunkMs)?options.processorOptions.chunkMs:80;this.frames=Math.round(sampleRate*ms/1000);this.data=new Float32Array(this.frames*2);this.used=0;this.start=0;}
  process(inputs,outputs) {
    const channels=inputs[0]||[],count=outputs[0]?.[0]?.length||128;
    // Missing input is silence on the same timeline, not a hole in time.
    for(let i=0;i<count;i++) {
      if(!this.used)this.start=currentTime+i/sampleRate;
      this.data[this.used*2]=channels[0]?.[i]||0;this.data[this.used*2+1]=(channels[1]||channels[0])?.[i]||0;
      if(++this.used===this.frames){this.port.postMessage({start:this.start,sampleRate,frames:this.frames,data:this.data},[this.data.buffer]);this.data=new Float32Array(this.frames*2);this.used=0;}
    }
    return true;
  }
}
registerProcessor('shared-music-capture',Capture);
