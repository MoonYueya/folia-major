// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachSeamWheelRelay, seamConsumesWheel } from '../../../../src/library/suites/bravais/bravaisSeamWheel';

// 缝里的滚轮（bug 修复用例）：缝是墙的滚轮容器 .lattice-field 的**兄弟**节点，指针落在信息条 / 书脊 / 标题 /
// 说明文字 / 折叠后的边缘标签上时 wheel 事件冒泡不到墙的监听，整条缝是滚轮死区。bravaisSeamWheel 把缝里的滚轮
// 接回墙上（监听挂在 stage 的根节点上）：缝里真能滚的祖先（展开后溢出的说明、挤满的信息条、横向溢出的首页窄缝）
// 先自己滚，滚到头再交给墙；同一手势里惯性的尾巴留在容器边上。
// 这里的 DOM 按 BravaisStage 的真实结构搭（field、缝、边缘标签是同一个 section 里的兄弟），滚动尺寸用
// defineProperty 摆出来——jsdom 不做排版，scrollHeight / clientHeight 一律为 0。

const buildSeam = () => {
    document.body.innerHTML = `
        <section class="bravais-root" data-bravais-seam-axis="y">
            <div class="lattice-field bravais-field"></div>
            <div class="bravais-seam-track">
                <div class="bravais-seam" data-bravais-seam-axis="y">
                    <div class="bravais-seam-content">
                        <div class="bravais-seam-body">
                            <div class="bravais-seam-row is-full">
                                <button type="button" class="bravais-seam-title-area" id="title"><span>望</span></button>
                                <div class="bravais-seam-row-info" id="info" data-wheel-scroll-region>
                                    <span id="meta">308 首</span>
                                    <button type="button" class="bravais-chrome-button" id="play">播放全部</button>
                                </div>
                                <div class="bravais-seam-blurb is-open" id="blurb" data-wheel-scroll-region>一段很长的简介</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <button type="button" class="bravais-seam-tab" id="tab">信息条</button>
        </section>
    `;
    const root = document.querySelector<HTMLElement>('.bravais-root')!;
    const seam = document.querySelector<HTMLElement>('.bravais-seam')!;
    const field = document.querySelector<HTMLElement>('.lattice-field')!;
    const byId = (id: string) => document.getElementById(id)!;
    return { root, seam, field, tab: byId('tab'), info: byId('info'), meta: byId('meta'), blurb: byId('blurb'), title: byId('title') };
};

type Metrics = { content: number; size: number; position?: number };

/** 让元素看起来像（或不像）一个滚动容器：overflow / 内容尺寸 / 滚动位置。 */
const stubScroll = (element: HTMLElement, axis: 'x' | 'y', { content, size, position = 0 }: Metrics) => {
    const [total, box, offset] = axis === 'y'
        ? ['scrollHeight', 'clientHeight', 'scrollTop'] as const
        : ['scrollWidth', 'clientWidth', 'scrollLeft'] as const;
    Object.defineProperty(element, total, { configurable: true, get: () => content });
    Object.defineProperty(element, box, { configurable: true, get: () => size });
    Object.defineProperty(element, offset, { configurable: true, get: () => position, set: () => {} });
    if (axis === 'y') element.style.overflowY = 'auto';
    else element.style.overflowX = 'auto';
};

/** 墙上那个 onWheel 的替身：拦下默认行为（真身就是 useWallPointerPan 交给 .lattice-field 的处理）。 */
const wallHandler = () => vi.fn((event: WheelEvent) => { event.preventDefault(); });

const wheel = (target: Element, init: WheelEventInit = { deltaY: NOTCH_PX }) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    const notCancelled = target.dispatchEvent(event);
    return { event, defaultPrevented: !notCancelled };
};

/** 这一小段里读了多少次样式（缝的宽度每帧都在被写，读布局越少越好）。 */
const countStyleReads = (run: () => void) => {
    const spy = vi.spyOn(window, 'getComputedStyle');
    run();
    const reads = spy.mock.calls.length;
    spy.mockRestore();
    return reads;
};

/** 手势锁的时长（SEAM_WHEEL_LATCH_MS = 160）之外。 */
const afterLatch = () => new Promise(resolve => setTimeout(resolve, 240));

/** 鼠标滚轮的一格（Chromium 约 100~120，不小于 minNotchPx 才算一格）。 */
const NOTCH_PX = 120;
/** 触控板的一发：单轴，但远小于一格（系统惯性峰值也在这里）。 */
const GLIDE_PX = 12;
/** 连续滚鼠标时相邻两格的间隔（真实是 50~120ms），一直在 160ms 的锁定时间内。 */
const NOTCH_GAP_MS = 70;
/** 触控板一发与下一发的间隔（约一帧），同一手势里不换来源。 */
const GLIDE_GAP_MS = 16;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 触控板的一发：小增量，墙的判别器把它算作 trackpad。 */
const glide = (target: Element, init: WheelEventInit = {}) => wheel(target, { deltaY: GLIDE_PX, ...init });

const pointerMove = (x: number, y: number) => {
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
};

afterEach(() => { document.body.innerHTML = ''; });

describe('缝里的滚轮接到墙上', () => {
    it('bug 的结构原因：缝里的 wheel 冒泡不到墙的滚轮容器，边缘标签也不在缝里面', () => {
        const { root, seam, field, tab, meta } = buildSeam();
        const onWall = vi.fn();
        field.addEventListener('wheel', onWall);
        wheel(meta);
        // field 与 seam 是兄弟节点，事件不经过 field —— 这就是信息条 / 书脊 / 标题上一滚就没有反应的原因。
        expect(onWall).not.toHaveBeenCalled();
        expect(seam.contains(meta)).toBe(true);
        // 折叠后唯一能停指针的面上是这条边缘标签：它是 seam 之外的第三个同级节点，所以 relay 的根必须提到 stage。
        expect(seam.contains(tab)).toBe(false);
        expect(root.contains(tab)).toBe(true);
        field.removeEventListener('wheel', onWall);
    });

    it('信息条装得下时（不能滚）：滚轮交给墙，页面照常滚', () => {
        const { root, meta, info } = buildSeam();
        // .bravais-seam-row-info 是 overflow-y: auto，308 首这类内容在横条里装得下 → 它滚不动。
        stubScroll(info, 'y', { content: 120, size: 120 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        const result = wheel(meta);
        expect(forward).toHaveBeenCalledTimes(1);
        expect(forward.mock.calls[0][0]).toBe(result.event);
        expect(result.defaultPrevented).toBe(true);
        detach();
    });

    it('列表容器装得下时（滚不动）交给墙，不变成新的死区', () => {
        const { root, seam } = buildSeam();
        // 组件用例里列表面板由 react-window 撑满，这里补「装得下」的那一支：面板的 List 根节点有 overflow: auto
        // 但内容比框矮 → 它不吃这一下，滚轮照常交给墙。
        const list = document.createElement('div');
        list.dataset.bravaisList = '';
        list.innerHTML = '<button type="button" id="list-row">第一首</button>';
        seam.querySelector('.bravais-seam-body')!.appendChild(list);
        stubScroll(list, 'y', { content: 80, size: 80 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        expect(wheel(document.getElementById('list-row')!).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('书脊 / 标题上没有能滚的东西：同样交给墙', () => {
        const { root, title } = buildSeam();
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        expect(wheel(title).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('折叠后指针停在边缘标签上滚轮，也交给墙（标签在缝之外，靠 stage 那层根覆盖）', () => {
        const { root, tab } = buildSeam();
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        const result = wheel(tab);
        expect(forward).toHaveBeenCalledTimes(1);
        expect(forward.mock.calls[0][0]).toBe(result.event);
        expect(result.defaultPrevented).toBe(true);
        detach();
    });

    it('落在 .lattice-field 里的 wheel 归墙自己那份监听：relay 不重复处理', () => {
        const { root, field } = buildSeam();
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        const result = wheel(field);
        expect(forward).not.toHaveBeenCalled();
        // 没被 relay 拦下（真身里 field 自己的 onWheel 已经 preventDefault 过一次）。
        expect(result.defaultPrevented).toBe(false);
        detach();
    });

    it('墙的手势锁在 window 捕获阶段截下的事件，relay 不再接一手（提升根节点不影响那条语义）', () => {
        const { root, meta } = buildSeam();
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        // useWallPointerPan 的 onLatchedWheel：锁定时对不在 container 里的目标 stopPropagation 后自己处理。
        const lock = (event: Event) => event.stopPropagation();
        window.addEventListener('wheel', lock, { capture: true });
        const result = wheel(meta);
        window.removeEventListener('wheel', lock, { capture: true });
        expect(forward).not.toHaveBeenCalled();
        expect(result.defaultPrevented).toBe(false);
        detach();
    });

    it('展开后真溢出的说明文字先自己滚，不交给墙', () => {
        const { root, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        // 往下滚：还能滚，原生滚动交给浏览器（不 preventDefault、不推相机）。
        expect(wheel(blurb).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();
        detach();
    });

    it('说明文字滚到底后再滚：交给墙（不在缝里停住）', () => {
        const { root, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 180 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        expect(wheel(blurb).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('说明文字滚到顶后往上滚，也接着滚页面', () => {
        const { root, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        expect(wheel(blurb, { deltaY: -120 }).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('触控板甩到底：惯性尾巴留在容器边上，停手超过锁定时间后才交给墙', async () => {
        const { root, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        // 第一下真的让说明文字自己滚。
        expect(glide(blurb).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();
        // 甩到底：后面这一手剩下的惯性事件还在同一手势里，不能接着推墙（原来会「滚完简介接着推墙」）。
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 180 });
        for (let index = 0; index < 4; index += 1) {
            await sleep(GLIDE_GAP_MS);
            const result = glide(blurb);
            expect(result.defaultPrevented).toBe(false);
        }
        expect(forward).not.toHaveBeenCalled();
        // 停手再滚是新手势：交给墙。
        await afterLatch();
        expect(wheel(blurb).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('鼠标滚轮滚到边后下一格就交给墙：一格一格的间隔（50~120ms）落在锁定时间内也不续命', async () => {
        const { root, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        // 第一格：说明文字自己滚，墙不动。
        expect(wheel(blurb).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();
        // 滚到底后继续滚：下一格离上一格只有一格滚轮的间隔，远不够解开锁，但它已经是新的一手——
        // 说明文字没得可滚，就交给墙，不必先停手 160ms。
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 180 });
        await sleep(NOTCH_GAP_MS);
        const atEdge = wheel(blurb);
        expect(atEdge.defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        // 接着滚还是推墙：没在边界上重新锁住自己。
        await sleep(NOTCH_GAP_MS);
        expect(wheel(blurb).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(2);
        detach();
    });

    it('离散鼠标滚轮还在能滚的时候连着滚：一直是说明文字自己滚，不交替推墙', async () => {
        const { root, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        for (let index = 0; index < 4; index += 1) {
            await sleep(NOTCH_GAP_MS);
            expect(wheel(blurb).defaultPrevented).toBe(false);
        }
        expect(forward).not.toHaveBeenCalled();
        detach();
    });

    it('光标挪开超过 4px 也算换了目标：锁定解开，边界上的滚轮交给墙', () => {
        const { root, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        glide(blurb);
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 180 });
        expect(glide(blurb).defaultPrevented).toBe(false);
        pointerMove(120, 120);
        expect(wheel(blurb).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('手势尾巴期间不再做布局读取（同一次手势的触控板事件不重新算边界）', () => {
        const { root, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        const readStyle = vi.spyOn(window, 'getComputedStyle');
        glide(blurb);
        const afterFirst = readStyle.mock.calls.length;
        expect(afterFirst).toBeGreaterThan(0);
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 180 });
        for (let index = 0; index < 5; index += 1) glide(blurb);
        expect(readStyle.mock.calls.length).toBe(afterFirst);
        readStyle.mockRestore();
        detach();
    });

    it('带标记的滚动容器命中后只在它这一层算边界（目标到它之间不再逐层读样式）', () => {
        const { root, info, meta } = buildSeam();
        stubScroll(info, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        // meta 是信息条里的一个 span：标记命中就直接看信息条，span 自己不必再问一次「你是不是滚动容器」。
        expect(countStyleReads(() => { wheel(meta); })).toBe(1);
        expect(forward).not.toHaveBeenCalled();
        detach();
    });

    it('标记的容器装得下时退回通用遍历：里面没标记的滚动容器照样自己滚', () => {
        const { root, info } = buildSeam();
        // 标记的这层装得下（滚不动），但它里面还有一个没标记、真能滚的容器：通用路径必须还能找到它，
        // 不能因为「命中过标记」就一路交给墙（列表面板里 react-window 的外层就是这种没标记的滚动容器）。
        stubScroll(info, 'y', { content: 120, size: 120 });
        const inner = document.createElement('div');
        inner.innerHTML = '<span id="inner-span">第一首</span>';
        info.appendChild(inner);
        stubScroll(inner, 'y', { content: 400, size: 200, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        expect(wheel(document.getElementById('inner-span')!).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();
        detach();
    });

    it('首页窄缝横向溢出：还能横向滚就先自己滚，到底了交回墙上', async () => {
        const { root, seam } = buildSeam();
        const nav = document.createElement('div');
        nav.className = 'bravais-seam-home-row-nav';
        nav.innerHTML = '<button type="button" id="nav-tab">书库</button>';
        seam.querySelector('.bravais-seam-body')!.appendChild(nav);
        const navTab = document.getElementById('nav-tab')!;

        stubScroll(nav, 'x', { content: 600, size: 320, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        expect(glide(navTab, { deltaX: GLIDE_PX, deltaY: 0 }).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();

        stubScroll(nav, 'x', { content: 600, size: 320, position: 280 });
        // 同一手势里触控板惯性还没停：仍然留在容器边上。
        expect(glide(navTab, { deltaX: GLIDE_PX, deltaY: 0 }).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();
        // 停手之后再滚，才交给墙。
        await afterLatch();
        expect(wheel(navTab, { deltaX: 120, deltaY: 0 }).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('Shift + 竖向滚轮在横向溢出的首页窄缝上先自己滚（和墙同一套换算）', () => {
        const { root, seam } = buildSeam();
        const nav = document.createElement('div');
        nav.className = 'bravais-seam-home-row-nav';
        nav.innerHTML = '<button type="button" id="shift-tab">书库</button>';
        seam.querySelector('.bravais-seam-body')!.appendChild(nav);
        const navTab = document.getElementById('shift-tab')!;

        stubScroll(nav, 'x', { content: 600, size: 320, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        // 不用 Shift：这一下是竖向的，窄缝没有纵向溢出 → 交给墙。
        expect(wheel(navTab, { deltaY: 120 }).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        // 按住 Shift：wallWheelDelta 把竖向改走横向，窄缝这一下还能横向滚 → 自己滚。
        expect(wheel(navTab, { deltaY: 120, shiftKey: true }).defaultPrevented).toBe(false);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('已经被 preventDefault 过的 wheel 不再 forward', () => {
        const { root, meta } = buildSeam();
        const swallow = (event: Event) => event.preventDefault();
        meta.addEventListener('wheel', swallow);
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        expect(wheel(meta).defaultPrevented).toBe(true);
        expect(forward).not.toHaveBeenCalled();
        detach();
    });

    it('Ctrl / ⌘ + 滚轮（缩放）既不拦也不推', () => {
        const { root, meta } = buildSeam();
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(root, forward);
        expect(wheel(meta, { deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(false);
        expect(wheel(meta, { deltaY: 120, metaKey: true }).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();
        detach();
    });

    it('卸载后缝里不再接滚轮', () => {
        const { root, meta } = buildSeam();
        const forward = wallHandler();
        attachSeamWheelRelay(root, forward)();
        wheel(meta);
        expect(forward).not.toHaveBeenCalled();
    });

    it('没有根节点（null）时退化成什么都不做，不抛错', () => {
        const forward = wallHandler();
        expect(() => attachSeamWheelRelay(null, forward)()).not.toThrow();
        expect(forward).not.toHaveBeenCalled();
    });
});

describe('seamConsumesWheel 的方向判断', () => {
    it('装得下（content 不大于 size）的 overflow: auto 不算能滚', () => {
        const { seam, info } = buildSeam();
        stubScroll(info, 'y', { content: 100, size: 100 });
        expect(seamConsumesWheel(info, seam, 0, 120)).toBe(false);
    });

    it('overflow: visible 的元素即使内容更高也不算能滚（它滚不动）', () => {
        const { seam, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 800, size: 240 });
        blurb.style.overflowY = 'visible';
        expect(seamConsumesWheel(blurb, seam, 0, 120)).toBe(false);
    });

    it('事件目标不是元素（document）时交给墙', () => {
        const { seam } = buildSeam();
        expect(seamConsumesWheel(document, seam, 0, 120)).toBe(false);
    });
});
