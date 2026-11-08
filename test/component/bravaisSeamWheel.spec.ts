import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { buildServiceStubModule, LOCAL_MUSIC_SERVICE_ROUTE } from '../../dev/probes/homeBehavior/serviceStubModule';
import '../../dev/probes/homeBehavior/probeApi';

// test/component/bravaisSeamWheel.spec.ts
// 缝里的滚轮（bug 修复用例，homeBehavior 探针 + setSuite('bravais')）：缝是墙的滚轮容器 .lattice-field 的兄弟
// 节点，指针落在信息条 / 书脊 / 标题上时 wheel 冒泡不到墙的监听，整条缝曾是滚轮死区。修好之后指针停在这些地方
// 滚轮应当和停在墙上一样推动墙（useWallPointerPan 的 onWheel 收到事件并 preventDefault）。
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

/** 指针停在某处滚滚轮：这一次必须被墙接住（preventDefault），并且墙真的动了。两个方向都试，避开有限的相机范围顶到头。 */
const expectWallPansFrom = async (page: Page, point: { x: number; y: number }) => {
    await page.mouse.move(point.x, point.y);
    const before = await worldTransform(page);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(500);
    if (await worldTransform(page) !== before) return;
    await page.mouse.wheel(0, -800);
    await page.waitForTimeout(500);
    expect(await worldTransform(page)).not.toBe(before);
};

/** 列表面板里那个真能滚的元素（react-window 的 List 根节点）现在滚到哪了。 */
const panelListScroll = (page: Page) => page.evaluate(() => {
    const panel = document.querySelector('[data-bravais-list]');
    const scroller = [...(panel?.querySelectorAll<HTMLElement>('*') ?? [])]
        .find(element => element.scrollHeight - element.clientHeight > 4);
    return { top: scroller?.scrollTop ?? 0, scrollable: Boolean(scroller) };
});

const centerOf = async (page: Page, locator: ReturnType<Page['locator']>) => {
    const box = await locator.first().boundingBox();
    expect(box).not.toBeNull();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
};

test.describe('[bravais-only] wheel over the seam', () => {
    test('wheeling over the info strip, the spine and the title scrolls the wall like the wall itself does', async ({ mount, page }) => {
        await mountBravais(mount, page);
        await setDirection(page, 'horizontal');
        await rowSettled(page);
        await openCard(page);
        await expect(seam(page)).toHaveAttribute('data-bravais-seam', 'full');
        await rowSettled(page);
        await recordWheel(page);

        // 常温状态：指针停在完整信息条的中间（元数据 / 简介那一栏）滚轮，墙照常走。
        await expectWallPansFrom(page, await centerOf(page, seam(page).locator('.bravais-seam-row-info')));
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

        // 每一次滚轮都被墙接住（缝里没有任何地方把它吃掉）。
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
        const panelPoint = await centerOf(page, panel);
        const scrollBefore = await panelListScroll(page);
        const worldBefore = await worldTransform(page);
        await page.mouse.move(panelPoint.x, panelPoint.y);
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(400);
        if (scrollBefore.scrollable) {
            expect((await panelListScroll(page)).top).toBeGreaterThan(scrollBefore.top);
            expect(await worldTransform(page)).toBe(worldBefore);
        } else {
            // 列表装得下、没得滚：那就该像墙上一样推动墙，不能变成新的死区。
            expect(await worldTransform(page)).not.toBe(worldBefore);
        }
    });
});
