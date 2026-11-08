import { wallWheelDelta } from '../../../components/wall/wallPanMotion';

// src/library/suites/bravais/bravaisSeamWheel.ts
// 缝（含折叠后那条边缘标签）里的滚轮接回墙：缝里能滚的容器先自己滚，其余交给墙的同一个 onWheel。

// 缝（横条 / 竖缝 / 书脊 / 首页窄缝）盖在墙上面，却是墙的滚轮容器 .lattice-field 的**兄弟**节点
// （BravaisStage 的渲染：field 一个子节点、BravaisSeam 紧挨在后面）。墙的滚轮平移只挂在 .lattice-field 上
// （useWallPointerPan 的 container.addEventListener('wheel', onWheel)），所以指针落在缝里时 wheel 事件
// 既不在 field 内、也冒泡不到它，整条缝是一块滚轮死区——信息条、书脊、标题、说明文字上都一样。
// 折叠 / 隐藏时缝的 width 收到 0、visibility: hidden，唯一能停指针的面是缝之外的第三个同级节点
// .bravais-seam-tab（BravaisSeam 的渲染），所以监听挂在 stage 的 <section> 上，不是挂在缝上。
// 这里把缝里的滚轮接回墙上，规则按「谁该吃掉这一下」分：
// 1. 缝里真有一个能滚的祖先（展开后放不下的说明文字 .bravais-seam-blurb.is-open、挤满时的 .bravais-seam-row-info、
//    横向溢出的首页窄缝导航段）且这一下还没到头 → 让它自己滚，不拦。
// 2. 其余（含「已经滚到头」）→ 拦下来交给墙上同一个滚轮处理，相机接着走。
// 同一个手势里由第 1 条吃下的容器继续吃（见 SEAM_WHEEL_LATCH_MS）：触控板甩到边界之后剩下的惯性事件
// 不会一转手就变成推墙。

/** 墙的滚轮容器：落在这里面的 wheel 由 useWallPointerPan 自己那份监听处理，relay 不重复接。 */
const WALL_FIELD_SELECTOR = '.lattice-field';
/** 这几个 overflow 值才是滚动容器：overflow: visible 的元素 scrollHeight 也会大于 clientHeight，但它滚不动。 */
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
/** 到头 / 到顶的容差：分数滚动位置（缩放后的 DPR）留一点余地，免得最后一格被当成「还能滚」而吃掉。 */
const EDGE_TOLERANCE_PX = 1;
/** 一个手势的长度：某个容器吃过一次后，这么久没有新的 wheel 才解锁（和 useWallPointerPan 的 WHEEL_LATCH_MS 同值）。 */
const SEAM_WHEEL_LATCH_MS = 160;
/** 光标真的挪开这么远也算换了目标，解锁。 */
const LATCH_MOVE_PX = 4;

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
    // 同一手势的锁：谁先吃下这一手就归谁，直到停手 SEAM_WHEEL_LATCH_MS 或光标挪开。锁定期间不碰布局。
    let latch: { timer: number; x: number; y: number } | null = null;
    const releaseLatch = () => {
        if (!latch) return;
        window.clearTimeout(latch.timer);
        latch = null;
        window.removeEventListener('pointermove', onLatchMove, true);
    };
    const onLatchMove = (event: globalThis.PointerEvent) => {
        if (latch && Math.hypot(event.clientX - latch.x, event.clientY - latch.y) > LATCH_MOVE_PX) releaseLatch();
    };
    const holdLatch = (event: WheelEvent) => {
        if (!latch) {
            latch = { timer: 0, x: event.clientX, y: event.clientY };
            window.addEventListener('pointermove', onLatchMove, true);
        }
        window.clearTimeout(latch.timer);
        latch.timer = window.setTimeout(releaseLatch, SEAM_WHEEL_LATCH_MS);
    };
    const onWheel = (event: WheelEvent) => {
        // 墙自己的容器里的 wheel 已经归 useWallPointerPan 处理：这里第一句就退出，任何 preventDefault 都还没发生。
        if (event.target instanceof Element && event.target.closest(WALL_FIELD_SELECTOR)) return;
        // 缩放（Ctrl / ⌘ + 滚轮）与墙上一致：不拦、不推。
        if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
        // 这一手还没结束：开头吃下它的容器继续归它，跳过边界计算（缝的宽度每帧都在被写）。
        if (latch) {
            holdLatch(event);
            return;
        }
        const { dx, dy } = wallWheelDelta(event, window.innerHeight);
        if (seamConsumesWheel(event.target, root, dx, dy)) {
            holdLatch(event);
            return;
        }
        forward(event);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
        releaseLatch();
        root.removeEventListener('wheel', onWheel);
    };
};
