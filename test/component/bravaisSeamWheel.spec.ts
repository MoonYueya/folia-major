import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { buildServiceStubModule, LOCAL_MUSIC_SERVICE_ROUTE } from '../../dev/probes/homeBehavior/serviceStubModule';
import '../../dev/probes/homeBehavior/probeApi';

// test/component/bravaisSeamWheel.spec.ts
// 缝里的滚轮（bug 修复用例，homeBehavior 探针 + setSuite('bravais')）：缝是墙的滚轮容器 .lattice-field 的兄弟
// 节点，指针落在信息条 / 书脊 / 标题上时 wheel 冒泡不到墙的监听，整条缝曾是滚轮死区。修好之后指针停在这些地方
// 滚轮应当和停在墙上一样推动墙（useWallPointerPan 的 onWheel 收到事件并 preventDefault）。折叠后唯一能停指针的
// 面（.bravais-seam-tab）是缝之外的第三个同级节点，所以 relay 的根提到 stage 的 <section>，这里也照着钉住。
// 断言口径：document 冒泡阶段读 defaultPrevented（墙的 onWheel 只做 preventDefault + 推相机），再看相机写在
// 世界层上的 transform 有没有变——两个都给，才不是只证明「有人拦了事件」。

const stage = (page: Page) => page.locator('[data-library-stage="bravais"]');
const seam = (page: Page) => page.locator('[data-bravais-seam]');
const settled = (page: Page) => expect(stage(page)).not.toHaveAttribute('data-bravais-settled', /.*/, { timeout: 10_000 });

const setDirection = (page: Page, direction: 'auto' | 'vertical' | 'horizontal') => page.evaluate(async value => {
    const modulePath = '/src/stores/useLibraryWallLookStore.ts';
    const { useLibraryWallLookStore } = await import(/* @vite-ignore */ modulePath);
    useLibraryWallLookStore.getState().setSeamDirection(value);
}, direction);

const mountBravais = async (mount: (id: string) => Promise<unknown>, page: Page) => {
    await page.route(LOCAL_MUSIC_SERVICE_ROUTE, route => route.fulfill({ contentType: 'text/javascript', body: buildServiceStubModule() }));
    await mount('homeBehavior');
    await expect.poll(() => page.evaluate(() => window.__homeProbe?.ready() ?? false), { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => window.__homeProbe!.setSuite('bravais'));
    await expect(stage(page)).toHaveAttribute('data-bravais-layer', 'home:playlist', { timeout: 15_000 });
    await settled(page);
};

/** 点开一张没被缝盖住的首页卡片（派发点击：探针左下角的 DEV 浮层可能盖住磁贴）。 */
const openCard = async (page: Page) => {
    const slot = await page.evaluate(() => {
        const seamRect = document.querySelector('[data-bravais-seam]')?.getBoundingClientRect();
        const tiles = [...document.querySelectorAll<HTMLElement>('.bravais-tile[data-library-card]')];
        return tiles.find(element => {
            const rect = element.getBoundingClientRect();
            const clear = !seamRect || rect.bottom < seamRect.top - 4 || rect.top > seamRect.bottom + 4;
            return rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight && clear;
        })?.dataset.bravaisSlot ?? null;
    });
    expect(slot).not.toBeNull();
    await page.locator(`[data-bravais-slot="${slot}"] article`).dispatchEvent('click');
    await expect.poll(() => page.evaluate(() => window.__homeProbe!.stack().length)).toBe(1);
    await settled(page);
};

/** 横条此刻完整张开（开口落定、不裁内容）。 */
const rowSettled = (page: Page) => expect(seam(page)).toHaveAttribute('data-bravais-seam-settled', '', { timeout: 5_000 });

/** 记下 document 在冒泡阶段收到的每一次 wheel 的 defaultPrevented。 */
const recordWheel = (page: Page) => page.evaluate(() => {
    const log: boolean[] = [];
    Object.assign(window, { __seamWheelLog: log });
    document.addEventListener('wheel', event => { log.push(event.defaultPrevented); }, { passive: true });
});

const wheelLog = (page: Page) => page.evaluate(() => (window as unknown as { __seamWheelLog: boolean[] }).__seamWheelLog);

/** 相机写在两块世界层上的 transform：墙有没有被推动，看它。 */
const worldTransform = (page: Page) => page.evaluate(() => (
    document.querySelector<HTMLElement>('[data-bravais-half="left"]')?.style.transform ?? ''
));

const centerOf = async (page: Page, locator: ReturnType<Page['locator']>) => {
    const box = await locator.first().boundingBox();
    expect(box).not.toBeNull();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
};

/** 探针的 DEV 浮层压在指针要落的那一点上时把它让开：它只是开发面板，不是被测的东西。 */
const clearPoint = (page: Page, point: { x: number; y: number }) => page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    const stageElement = document.querySelector('[data-library-stage="bravais"]');
    if (!top || !stageElement || stageElement.contains(top)) return;
    let node: HTMLElement | null = top instanceof HTMLElement ? top : null;
    while (node && getComputedStyle(node).position !== 'fixed') node = node.parentElement;
    if (node) node.style.pointerEvents = 'none';
}, point);

/** 在这一点滚一下，记下这一步里 document 收到的 wheel（只看这一段，不累加）。 */
const wheelAt = async (page: Page, point: { x: number; y: number }, deltaY: number) => {
    const before = await worldTransform(page);
    const logged = (await wheelLog(page)).length;
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(500);
    return {
        before,
        after: await worldTransform(page),
        prevented: (await wheelLog(page)).slice(logged),
    };
};

/**
 * 指针停在某处滚滚轮：这一步的 wheel 全被墙接住，墙也真的动了。
 * firstStep 时只试一个方向：首轮之前没有墙的 wheel，useWallPointerPan 的 160ms 手势锁不可能存在，所以这一下
 * 只能由 relay 接回来；一味反向补一刀（+400 不动就 -800）会把「relay 根本没接」盖成「相机已经到界」。
 * 后面几步两个方向都试，是因为相机范围有限，撞到上界时正方向本来就不会动。
 */
const expectWallPansFrom = async (page: Page, point: { x: number; y: number }, options: { firstStep?: boolean } = {}) => {
    const step = await wheelAt(page, point, 400);
    expect(step.prevented.length).toBeGreaterThan(0);
    expect(step.prevented.filter(prevented => !prevented)).toEqual([]);
    if (step.after !== step.before) return;
    if (options.firstStep) {
        expect(step.after).not.toBe(step.before);
        return;
    }
    const back = await wheelAt(page, point, -800);
    expect(back.prevented.filter(prevented => !prevented)).toEqual([]);
    expect(back.after).not.toBe(back.before);
};

/** 列表面板里那个真能滚的元素（react-window 的 List 根节点）现在滚到哪了：口径与实现同一套（computed overflow）。 */
const panelListScroll = (page: Page) => page.evaluate(() => {
    const panel = document.querySelector('[data-bravais-list]');
    const scroller = [...(panel?.querySelectorAll<HTMLElement>('*') ?? [])].find(element => {
        if (!['auto', 'scroll', 'overlay'].includes(getComputedStyle(element).overflowY)) return false;
        return element.scrollHeight - element.clientHeight > 4;
    });
    return { top: scroller?.scrollTop ?? 0, scrollable: Boolean(scroller) };
});

test.describe('[bravais-only] wheel over the seam', () => {
    test('wheeling over the info strip, the spine and the title scrolls the wall like the wall itself does', async ({ mount, page }) => {
        await mountBravais(mount, page);
        await setDirection(page, 'horizontal');
        await rowSettled(page);
        await openCard(page);
        await expect(seam(page)).toHaveAttribute('data-bravais-seam', 'full');
        await rowSettled(page);
        await recordWheel(page);

        // 常温状态：指针停在完整信息条的中间（元数据 / 简介那一栏）滚轮，墙照常走。第一下只试一个方向。
        await expectWallPansFrom(page, await centerOf(page, seam(page).locator('.bravais-seam-row-info')), { firstStep: true });
        // 大标题区域（点它是「收起成书脊」的按钮）也一样。
        await expectWallPansFrom(page, await centerOf(page, seam(page).locator('.bravais-seam-title-area')));

        // 书脊那一行上滚轮同样推动墙（滚过墙之后缝可能已经自己收成书脊，那就直接量它）。
        const spineRow = seam(page).locator('[data-bravais-seam-row="spine"]');
        if (await spineRow.count() === 0) {
            // 派发点击：大标题在开合途中不一定「稳定」，Playwright 的可见性等待会白等到超时。
            await seam(page).locator('.bravais-seam-title-area').dispatchEvent('click');
        }
        await expect(spineRow).toHaveCount(1);
        await rowSettled(page);
        await expectWallPansFrom(page, await centerOf(page, seam(page).locator('[data-bravais-seam-row="spine"]')));

        // 累计日志留在这里，是因为它证明的不是某一步，而是整段：信息条、标题、书脊每一处滚过的每一次 wheel 都被
        // 墙接住了，中间没有一下漏给别处（单步断言只看自己那一小段）。长度按步数取一个下限，不按精确次数钉死。
        const log = await wheelLog(page);
        expect(log.length).toBeGreaterThanOrEqual(3);
        expect(log.filter(prevented => !prevented)).toEqual([]);

        // 反过来：缝里真能滚的地方不许被这条接缝吃掉——列表面板（react-window）的滚轮还得滚列表，墙不动。
        // 先把书脊展回完整信息条（「列表」入口在完整信息条上）。
        const expand = seam(page).locator('[data-bravais-seam-action="expand"]');
        if (await expand.count() > 0) await expand.first().dispatchEvent('click');
        await expect(seam(page)).toHaveAttribute('data-bravais-seam', 'full', { timeout: 5_000 });
        await rowSettled(page);
        await seam(page).locator('[data-bravais-seam-action="list"]').click();
        await expect(seam(page)).toHaveAttribute('data-bravais-seam', 'panel', { timeout: 5_000 });
        const panel = seam(page).locator('[data-bravais-list]');
        await expect(panel).toBeVisible();
        const scrollBefore = await panelListScroll(page);
        // 「列表归自己滚」这一条必须钉成事实：以前这里是 if (scrollable) … else …，判不中（尺寸对不上）就滑进
        // else 照样通过。装得下、没得滚的那种情况由单测的「列表容器装得下时交给墙」覆盖。
        expect(scrollBefore.scrollable).toBe(true);
        const worldBefore = await worldTransform(page);
        await page.mouse.move((await centerOf(page, panel)).x, (await centerOf(page, panel)).y);
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(400);
        expect((await panelListScroll(page)).top).toBeGreaterThan(scrollBefore.top);
        expect(await worldTransform(page)).toBe(worldBefore);
    });

    test('the folded edge label over the seam also scrolls the wall (it lives outside the seam element)', async ({ mount, page }) => {
        await mountBravais(mount, page);
        await setDirection(page, 'horizontal');
        await rowSettled(page);
        // 折叠：缝收成 0 宽、visibility: hidden，唯一能停指针的面就是这条竖标签。
        await page.locator('[data-bravais-seam-action="hide"]').first().click();
        await expect(seam(page)).toHaveAttribute('data-bravais-seam-level', 'hidden');
        const tab = page.locator('.bravais-seam-tab');
        await expect(tab).toBeVisible();
        // 结构事实：标签不在缝里面——relay 的根原来只挂到缝，所以这条竖带一直是死区。
        expect(await tab.evaluate(node => Boolean(node.closest('[data-bravais-seam]')))).toBe(false);

        // hover 会等标签滑进来的动画落定：动画途中量到的框还在屏幕外（translate(-100%)），指针落不到东西上。
        await tab.hover();
        const point = await centerOf(page, tab);
        await clearPoint(page, point);
        await recordWheel(page);
        await expectWallPansFrom(page, point, { firstStep: true });
    });

    test('a seam container that scrolls itself keeps the wheel, and its inertia tail never lands on the wall', async ({ mount, page }) => {
        await mountBravais(mount, page);
        await setDirection(page, 'horizontal');
        await rowSettled(page);
        await openCard(page);
        await expect(seam(page)).toHaveAttribute('data-bravais-seam', 'full');
        await rowSettled(page);

        // 信息条：.bravais-seam-row-info 自己就是 overflow-y: auto（bravaisSeamRow.css）。塞一行长元数据进去，
        // 它就真的比自己的框高——真实 CSS 的滚动规则，不是靠列表面板。
        const info = await page.evaluate(() => {
            const element = document.querySelector<HTMLElement>('[data-bravais-seam] .bravais-seam-row-info');
            if (!element) return null;
            const filler = document.createElement('div');
            filler.style.flex = 'none';
            filler.textContent = Array.from({ length: 40 }, (_, index) => `${index + 1} songs · 3:2${index % 10}`).join(' / ');
            element.append(filler);
            const rect = element.getBoundingClientRect();
            return {
                overflowY: getComputedStyle(element).overflowY,
                scrollable: element.scrollHeight - element.clientHeight > 4,
                left: rect.left, top: rect.top, width: rect.width, height: rect.height,
            };
        });
        expect(info).not.toBeNull();
        expect(info!.overflowY).toBe('auto');
        expect(info!.scrollable).toBe(true);
        const point = { x: info!.left + info!.width / 2, y: info!.top + info!.height / 2 };
        await recordWheel(page);
        const worldBefore = await worldTransform(page);
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(0, 200);
        await page.waitForTimeout(400);
        const scrolled = await page.evaluate(() => document.querySelector<HTMLElement>('[data-bravais-seam] .bravais-seam-row-info')!.scrollTop);
        expect(scrolled).toBeGreaterThan(0);
        // 信息条自己滚的这几下墙没动。
        expect(await worldTransform(page)).toBe(worldBefore);

        // 甩到底：同一手势里剩下的惯性事件留在信息条边上，不接着推墙（修好之前会「滚完简介接着推墙」）。
        // 一次手势要在 160ms 的锁里跑完，所以整段（能滚的一下 + 甩到底 + 惯性尾巴）在页面里一次派发完，
        // 不用 mouse.wheel 一来一回（那是几百毫秒，早就被当成新手势了）。
        const tail = await page.evaluate(point => {
            const element = document.querySelector<HTMLElement>('[data-bravais-seam] .bravais-seam-row-info')!;
            const prevented: boolean[] = [];
            const send = () => {
                const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, clientX: point.x, clientY: point.y });
                element.dispatchEvent(event);
                prevented.push(event.defaultPrevented);
            };
            element.scrollTop = 0;
            send();
            element.scrollTop = element.scrollHeight;
            send();
            send();
            send();
            return prevented;
        }, point);
        // 第一下容器自己滚（不拦），甩到底之后的三下仍然归它（惯性尾巴），一下都不推墙。
        expect(tail).toEqual([false, false, false, false]);
        expect(await worldTransform(page)).toBe(worldBefore);

        // 停手超过锁定时间再看：这一手结束了，滚轮交回墙上。
        await page.waitForTimeout(300);
        await clearPoint(page, point);
        await expectWallPansFrom(page, point, { firstStep: true });
    });
});
