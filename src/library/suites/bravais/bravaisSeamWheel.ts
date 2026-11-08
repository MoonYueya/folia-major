// src/library/suites/bravais/bravaisSeamWheel.ts

import { wallWheelDelta } from '../../../components/wall/wallPanMotion';

// 缝（横条 / 竖缝 / 书脊 / 首页窄缝）盖在墙上面，却是墙的滚轮容器 .lattice-field 的**兄弟**节点
// （BravaisStage 的渲染：field 一个子节点、BravaisSeam 紧挨在后面）。墙的滚轮平移只挂在 .lattice-field 上
// （useWallPointerPan 的 container.addEventListener('wheel', onWheel)），所以指针落在缝里时 wheel 事件
// 既不在 field 内、也冒泡不到它，整条缝是一块滚轮死区——信息条、书脊、标题、说明文字上都一样。
// 这里把缝里的滚轮接回墙上，规则按「谁该吃掉这一下」分：
// 1. 缝里真有一个能滚的祖先（展开后放不下的说明文字 .bravais-seam-blurb.is-open、挤满时的 .bravais-seam-row-info、
//    横向溢出的首页窄缝导航段）且这一下还没到头 → 让它自己滚，不拦。
// 2. 其余（含「已经滚到头」）→ 拦下来交给墙上同一个滚轮处理，相机接着走。
// 因为交接在这一层完成，bravais.css / bravaisSeamRow.css 里那几个 overscroll-behavior: contain 不再有能力
// 把滚轮掐死在缝里：contain 管的是原生链式滚动，而到头之后的那一下根本走不到原生那一步。

/** 这几个 overflow 值才是滚动容器：overflow: visible 的元素 scrollHeight 也会大于 clientHeight，但它滚不动。 */
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
/** 到头 / 到顶的容差：分数滚动位置（缩放后的 DPR）留一点余地，免得最后一格被当成「还能滚」而吃掉。 */
const EDGE_TOLERANCE_PX = 1;

const isScrollContainer = (element: HTMLElement, axis: 'x' | 'y') => {
    const style = window.getComputedStyle(element);
    return SCROLLABLE_OVERFLOW.has(axis === 'y' ? style.overflowY : style.overflowX);
};

/** 这个元素在这一下滚轮的方向上还能不能滚：装得下不算，滚到头 / 到顶也不算。 */
const canScrollBy = (element: HTMLElement, axis: 'x' | 'y', delta: number) => {
    if (delta === 0 || !isScrollContainer(element, axis)) return false;
    const size = axis === 'y' ? element.clientHeight : element.clientWidth;
    const total = axis === 'y' ? element.scrollHeight : element.scrollWidth;
    if (total - size <= EDGE_TOLERANCE_PX) return false;
    const position = axis === 'y' ? element.scrollTop : element.scrollLeft;
    return delta > 0
        ? position + size < total - EDGE_TOLERANCE_PX
        : position > EDGE_TOLERANCE_PX;
};

/**
 * 这一下滚轮该由缝里的某个滚动容器吃掉吗：从事件目标往上找到 root（含），遇到第一个在这方向上还能滚的
 * 滚动容器就交给它。位移用 wallWheelDelta 归一（按行 / 页换算、Shift + 竖向改走横向），和墙的判断同一套。
 */
export const seamConsumesWheel = (target: EventTarget | null, root: HTMLElement, dx: number, dy: number) => {
    if (!(target instanceof Element)) return false;
    const axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    const delta = axis === 'x' ? dx : dy;
    if (delta === 0) return false;
    for (let element: Element | null = target; element; element = element.parentElement) {
        if (canScrollBy(element as HTMLElement, axis, delta)) return true;
        if (element === root) break;
    }
    return false;
};

/**
 * 把缝里的滚轮接到墙上（forward 就是 useWallPointerPan 交给 .lattice-field 的那个 onWheel：
 * preventDefault、推相机、顺手接管手势锁定）。返回卸载函数。
 */
export const attachSeamWheelRelay = (root: HTMLElement | null, forward: (event: WheelEvent) => void) => {
    if (!root) return () => {};
    const onWheel = (event: WheelEvent) => {
        // 缩放（Ctrl / ⌘ + 滚轮）与墙上一致：不拦、不推。
        if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
        const { dx, dy } = wallWheelDelta(event, window.innerHeight);
        if (seamConsumesWheel(event.target, root, dx, dy)) return;
        forward(event);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
};
