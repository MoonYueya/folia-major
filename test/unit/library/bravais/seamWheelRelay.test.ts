// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachSeamWheelRelay, seamConsumesWheel } from '../../../../src/library/suites/bravais/bravaisSeamWheel';

// 缝里的滚轮（bug 修复用例）：缝是墙的滚轮容器 .lattice-field 的**兄弟**节点，指针落在信息条 / 书脊 / 标题 /
// 说明文字上时 wheel 事件冒泡不到墙的监听，整条缝是滚轮死区。bravaisSeamWheel 把缝里的滚轮接回墙上：
// 缝里真能滚的祖先（展开后溢出的说明、挤满的信息条、横向溢出的首页窄缝）先自己滚，滚到头再交给墙。
// 这里的 DOM 按 BravaisStage 的真实结构搭（field 与 seam 兄弟），滚动尺寸用 defineProperty 摆出来——
// jsdom 不做排版，scrollHeight / clientHeight 一律为 0。

const buildSeam = () => {
    document.body.innerHTML = `
        <section class="bravais-root" data-bravais-seam-axis="y">
            <div class="lattice-field bravais-field"></div>
            <div class="bravais-seam" data-bravais-seam-axis="y">
                <div class="bravais-seam-content">
                    <div class="bravais-seam-body">
                        <div class="bravais-seam-row is-full">
                            <button type="button" class="bravais-seam-title-area" id="title"><span>望</span></button>
                            <div class="bravais-seam-row-info" id="info">
                                <span id="meta">308 首</span>
                                <button type="button" class="bravais-chrome-button" id="play">播放全部</button>
                            </div>
                            <div class="bravais-seam-blurb is-open" id="blurb">一段很长的简介</div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    `;
    const seam = document.querySelector<HTMLElement>('.bravais-seam')!;
    const field = document.querySelector<HTMLElement>('.lattice-field')!;
    const byId = (id: string) => document.getElementById(id)!;
    return { seam, field, info: byId('info'), meta: byId('meta'), blurb: byId('blurb'), title: byId('title') };
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

const wheel = (target: Element, init: WheelEventInit = { deltaY: 120 }) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    const notCancelled = target.dispatchEvent(event);
    return { event, defaultPrevented: !notCancelled };
};

afterEach(() => { document.body.innerHTML = ''; });

describe('缝里的滚轮接到墙上', () => {
    it('bug 的结构原因：缝里的 wheel 冒泡不到墙的滚轮容器', () => {
        const { seam, field, meta } = buildSeam();
        const onWall = vi.fn();
        field.addEventListener('wheel', onWall);
        wheel(meta);
        // field 与 seam 是兄弟节点，事件不经过 field —— 这就是信息条 / 书脊 / 标题上一滚就没有反应的原因。
        expect(onWall).not.toHaveBeenCalled();
        expect(seam.contains(meta)).toBe(true);
        field.removeEventListener('wheel', onWall);
    });

    it('信息条装得下时（不能滚）：滚轮交给墙，页面照常滚', () => {
        const { seam, meta, info } = buildSeam();
        // .bravais-seam-row-info 是 overflow-y: auto，308 首这类内容在横条里装得下 → 它滚不动。
        stubScroll(info, 'y', { content: 120, size: 120 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(seam, forward);
        const result = wheel(meta);
        expect(forward).toHaveBeenCalledTimes(1);
        expect(forward.mock.calls[0][0]).toBe(result.event);
        expect(result.defaultPrevented).toBe(true);
        detach();
    });

    it('书脊 / 标题上没有能滚的东西：同样交给墙', () => {
        const { seam, title } = buildSeam();
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(seam, forward);
        expect(wheel(title).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('展开后真溢出的说明文字先自己滚，不交给墙', () => {
        const { seam, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(seam, forward);
        // 往下滚：还能滚，原生滚动交给浏览器（不 preventDefault、不推相机）。
        expect(wheel(blurb).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();
        detach();
    });

    it('说明文字滚到底后接着滚页面（不是被 overscroll-behavior: contain 掐死）', () => {
        const { seam, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 180 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(seam, forward);
        expect(wheel(blurb).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('说明文字滚到顶后往上滚，也接着滚页面', () => {
        const { seam, blurb } = buildSeam();
        stubScroll(blurb, 'y', { content: 420, size: 240, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(seam, forward);
        expect(wheel(blurb, { deltaY: -120 }).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('首页窄缝横向溢出：还能横向滚就先自己滚，到底了交回墙上', () => {
        const { seam } = buildSeam();
        const nav = document.createElement('div');
        nav.className = 'bravais-seam-home-row-nav';
        nav.innerHTML = '<button type="button" id="tab">书库</button>';
        seam.querySelector('.bravais-seam-body')!.appendChild(nav);
        const tab = document.getElementById('tab')!;

        stubScroll(nav, 'x', { content: 600, size: 320, position: 0 });
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(seam, forward);
        expect(wheel(tab, { deltaX: 120, deltaY: 0 }).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();

        stubScroll(nav, 'x', { content: 600, size: 320, position: 280 });
        expect(wheel(tab, { deltaX: 120, deltaY: 0 }).defaultPrevented).toBe(true);
        expect(forward).toHaveBeenCalledTimes(1);
        detach();
    });

    it('Ctrl / ⌘ + 滚轮（缩放）既不拦也不推', () => {
        const { seam, meta } = buildSeam();
        const forward = wallHandler();
        const detach = attachSeamWheelRelay(seam, forward);
        expect(wheel(meta, { deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(false);
        expect(wheel(meta, { deltaY: 120, metaKey: true }).defaultPrevented).toBe(false);
        expect(forward).not.toHaveBeenCalled();
        detach();
    });

    it('卸载后缝里不再接滚轮', () => {
        const { seam, meta } = buildSeam();
        const forward = wallHandler();
        attachSeamWheelRelay(seam, forward)();
        wheel(meta);
        expect(forward).not.toHaveBeenCalled();
    });

    it('没有缝（null）时退化成什么都不做，不抛错', () => {
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
