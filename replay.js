'use strict';

/**
 * 全量重放：从道具初始区位出发，按提示号升序逐组校验并应用转移。
 *
 * 规则：
 *  - 每组转移基于「该组变动前」的状态校验来源区位；
 *  - 同组内每件道具最多转移一次；
 *  - 整组应用后，除「后台」外任一区位不得被多件道具占用（允许同组互换）；
 *  - 任一条校验失败则整组不生效，状态保持变动前，并记录全部冲突原因。
 *
 * @param {Array<{name:string, unlimited:boolean}>} locations
 * @param {Array<{name:string, location:string}>}   props
 * @param {Array<{number:number, note:string, transfers:Array<{prop:string, from:string, to:string}>}>} cues 已按提示号升序
 * @returns {{results: Array, finalState: Object<string,string>, finalLocations: Object<string,string[]>}}
 */
function replay(locations, props, cues) {
  const locDef = new Map(locations.map((l) => [l.name, l]));

  // 当前状态：道具 -> 区位（从初始区位开始）
  const state = {};
  for (const p of props) state[p.name] = p.location;

  const results = [];

  for (const cue of cues) {
    const errors = [];

    // 1) 同组内同一道具不得出现多次（数据库有唯一约束，这里兜底防御）
    const seen = new Set();
    for (const t of cue.transfers) {
      if (seen.has(t.prop)) errors.push(`道具「${t.prop}」在本组中被转移多次`);
      seen.add(t.prop);
    }

    // 2) 基于变动前状态校验来源
    for (const t of cue.transfers) {
      if (!(t.prop in state)) {
        errors.push(`道具「${t.prop}」不存在`);
      } else if (state[t.prop] !== t.from) {
        errors.push(`道具「${t.prop}」当前位于「${state[t.prop]}」，不在来源区位「${t.from}」`);
      }
      if (!locDef.has(t.to)) {
        errors.push(`目标区位「${t.to}」不存在`);
      }
    }

    // 3) 试算整组完成后的占用情况（来源校验通过才有意义）
    let next = null;
    if (errors.length === 0) {
      next = { ...state };
      for (const t of cue.transfers) next[t.prop] = t.to;

      const occupancy = new Map(); // 区位 -> [道具]
      for (const [prop, loc] of Object.entries(next)) {
        if (!occupancy.has(loc)) occupancy.set(loc, []);
        occupancy.get(loc).push(prop);
      }
      for (const [loc, occupants] of occupancy) {
        const def = locDef.get(loc);
        if (def && !def.unlimited && occupants.length > 1) {
          errors.push(
            `区位「${loc}」容量为一件，本组完成后将被 ${occupants.map((p) => `「${p}」`).join('、')} 同时占用`
          );
        }
      }
    }

    if (errors.length === 0 && next) {
      // 整组通过才提交
      Object.assign(state, next);
      results.push({ number: cue.number, note: cue.note, ok: true, errors: [], transfers: cue.transfers });
    } else {
      // 整组不生效，状态回滚（保持不变）
      results.push({ number: cue.number, note: cue.note, ok: false, errors, transfers: cue.transfers });
    }
  }

  // 汇总最终区位：区位 -> [道具]
  const finalLocations = {};
  for (const l of locations) finalLocations[l.name] = [];
  for (const [prop, loc] of Object.entries(state)) {
    if (!finalLocations[loc]) finalLocations[loc] = [];
    finalLocations[loc].push(prop);
  }

  return { results, finalState: state, finalLocations };
}

module.exports = { replay };
