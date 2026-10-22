/** Per-block genetic optimization with bounded work batches and reusable candidate storage. */

/**
 * Clamp a gene to its supported range.
 * @param x - Candidate color or depth value.
 * @returns Value constrained to zero through one.
 */
const clamp=x=>Math.max(0,Math.min(1,x));

/**
 * Allocate persistent buffers for a block population.
 * @param pixels - Source RGBA pixel bytes.
 * @param population - Candidate count per block.
 * @param random - Random source returning values in [0, 1).
 * @returns Empty optimizer state ready for batched initialization.
 */
function allocate(pixels,population,random){
    const count=pixels.length/4;
    return {count,population,random,generation:0,target:new Float32Array(count*4),genes:new Float32Array(count*population*4),best:new Float32Array(count*4),errors:new Float64Array(count),scratch:new Float32Array(population*4),totalError:0,error:0};
}

/**
 * Measure one candidate against its block's target.
 * @param state - Image optimizer buffers.
 * @param tile - Block index.
 * @param member - Candidate index within that block.
 * @returns Weighted squared color/depth error; lower is better.
 */
function error(state,tile,member){
    const offset=(tile*state.population+member)*4;let sum=0;
    for(let c=0;c<4;c++)sum+=(state.genes[offset+c]-state.target[tile*4+c])**2*(c===3?.25:1);
    return sum;
}

/**
 * Refresh one block's elite and update the overall error incrementally.
 * @param state - Mutable image optimizer.
 * @param tile - Block index to evaluate.
 * @returns No value; updates the block's best genes and aggregate match score.
 */
function evaluateTile(state,tile){
    let best=0,fitness=error(state,tile,0);
    for(let member=1;member<state.population;member++){const e=error(state,tile,member);if(e<fitness){best=member;fitness=e;}}
    const offset=(tile*state.population+best)*4;
    for(let c=0;c<4;c++)state.best[tile*4+c]=state.genes[offset+c];
    state.totalError+=fitness-state.errors[tile];state.errors[tile]=fitness;
}

/**
 * Initialize a bounded slice of source pixels and random candidate genomes.
 * @param state - Newly allocated optimizer.
 * @param pixels - Source RGBA bytes.
 * @param start - First included block index.
 * @param end - Exclusive block index limit.
 * @returns No value; initializes targets, candidates, and elite genes in the slice.
 */
function initializeRange(state,pixels,start,end){
    for(let tile=start;tile<end;tile++){
        const t=tile*4;
        for(let c=0;c<3;c++)state.target[t+c]=pixels[t+c]/255;
        state.target[t+3]=.15+.85*(.2126*state.target[t]+.7152*state.target[t+1]+.0722*state.target[t+2]);
        const base=tile*state.population*4;
        for(let i=0;i<state.population*4;i++)state.genes[base+i]=state.random();
        evaluateTile(state,tile);
    }
    state.error=Math.max(0,state.totalError/(state.count*3.25));
}

/**
 * Initialize a full optimizer synchronously for small images and algorithm tests.
 * @param pixels - Sampled RGBA image bytes.
 * @param population - Candidate count per block, default eight.
 * @param random - Random source; defaults to Math.random.
 * @returns Initialized optimizer with target genes and evaluated random candidates.
 */
export function createImageEvolution(pixels,population=8,random=Math.random){
    const state=allocate(pixels,population,random);initializeRange(state,pixels,0,state.count);return state;
}

/**
 * Initialize large images in chunks so the browser can draw and accept new input.
 * @param pixels - Sampled RGBA image bytes.
 * @param cancelled - Callback reporting whether this build has been superseded.
 * @returns Promise resolving to initialized state, or null if cancelled.
 */
export async function createImageEvolutionAsync(pixels,cancelled=()=>false){
    const state=allocate(pixels,8,Math.random);
    for(let start=0;start<state.count;start+=4096){
        if(cancelled())return null;
        initializeRange(state,pixels,start,Math.min(start+4096,state.count));
        await new Promise(resolve=>setTimeout(resolve,0));
    }
    return cancelled()?null:state;
}

/**
 * Select a fitter parent through a three-candidate tournament.
 * @param state - Image optimizer and random source.
 * @param tile - Current block index.
 * @returns Offset of the selected parent's first gene.
 */
function select(state,tile){
    let best=Math.floor(state.random()*state.population);
    for(let j=0;j<2;j++){const candidate=Math.floor(state.random()*state.population);if(error(state,tile,candidate)<error(state,tile,best))best=candidate;}
    return (tile*state.population+best)*4;
}

/**
 * Evolve a slice of blocks while reusing a single small scratch population.
 * @param state - Mutable optimizer state.
 * @param mutation - Mutation probability from zero through one.
 * @param start - First included block index.
 * @param end - Exclusive block index limit.
 * @returns Same state with updated elites for this slice; the caller tracks full generations.
 */
export function evolveImageRange(state,mutation,start,end){
    const {population,random,scratch}=state;
    for(let tile=start;tile<Math.min(end,state.count);tile++){
        const base=tile*population*4;
        for(let c=0;c<4;c++)scratch[c]=state.best[tile*4+c];
        for(let member=1;member<population;member++){
            const a=select(state,tile),b=select(state,tile);
            for(let c=0;c<4;c++){
                let gene=state.genes[(random()<.5?a:b)+c];
                if(random()<mutation)gene+=(random()-.5)*(random()<.1?1:.16);
                scratch[member*4+c]=clamp(gene);
            }
        }
        state.genes.set(scratch,base);evaluateTile(state,tile);
    }
    state.error=Math.max(0,state.totalError/(state.count*3.25));return state;
}

/**
 * Evolve one complete generation synchronously.
 * @param state - Mutable image optimizer.
 * @param mutation - Mutation probability; defaults to 0.3.
 * @returns Same optimizer after one full generation.
 */
export function evolveImage(state,mutation=.3){evolveImageRange(state,mutation,0,state.count);state.generation++;return state;}
