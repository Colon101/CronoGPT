#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  BrowserCronometerProvider,
  __clearDiaryEntrySelectionsForTests,
  __clickDiaryFoodEntryRowForTests,
  __commitAndVerifyPersistedFoodLogForTests,
  __proveTargetedDiaryEntrySelectionForTests,
  __verifyDiaryFoodDeletionEffectForTests,
} from "../dist/providers/browser.js";

const TIME_ZONE = "Asia/Jerusalem";
const failures = [];

function checkFixture(name, assertion) {
  try {
    assertion();
  } catch (error) {
    if (error instanceof Error) error.message = `${name}: ${error.message}`;
    failures.push(error);
  }
}

function isoDateInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDaysIso(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function cronometerDateLabel(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function providerForFixture(page) {
  const provider = new BrowserCronometerProvider({
    localChromium: false,
    writeEnabled: false,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 2_000,
    loginBackoffMs: 1_000,
    operationTimeoutMs: 5_000,
    browserRetryCount: 0,
    timeZone: TIME_ZONE,
  });

  // TypeScript private methods remain ordinary prototype methods at runtime.
  // This keeps the fixture local while exercising production date selection and
  // row extraction through the public operation.
  provider.withPage = async (_feature, handler) => handler(page);
  provider.openApp = async () => undefined;
  return provider;
}

function mealSection(title, entry = "") {
  return `<table class="diary-table"><tbody>
    <tr><td class="diary-group-title">${title}</td><td></td><td></td><td></td><td></td><td></td></tr>
    ${entry}
  </tbody></table>`;
}

function foodRow(name, amount, unit = "g") {
  return `<tr class="food-row"><td></td><td class="food-name">${name}</td><td>${amount}</td><td>${unit}</td><td>10</td><td>kcal</td></tr>`;
}

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
try {
  const page = await browser.newPage();
  const today = isoDateInTimeZone(TIME_ZONE);
  const yesterday = addDaysIso(today, -1);
  const twoDaysAgo = addDaysIso(today, -2);
  const yesterdayLabel = cronometerDateLabel(yesterday);
  const twoDaysAgoLabel = cronometerDateLabel(twoDaysAgo);

  await page.setContent(`
    <style>button, table, tr, td, [role='dialog'], input { display: block; width: 220px; min-height: 20px; }</style>
    <nav>Dashboard Diary Trends Foods</nav>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-next">Next</button>
      <button class="diary-date-btn">${yesterdayLabel}</button>
      ${mealSection("Breakfast", foodRow("Yesterday Food", 1))}
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
      <button id="food-button">FOOD</button>
    </main>
    <script>
      window.foodOpenedOn = '';
      document.querySelector('.diary-date-next').addEventListener('click', () => {
        document.querySelector('.diary-date-btn').textContent = 'Today';
        document.querySelector('.food-name').textContent = 'Today Food';
      });
      document.querySelector('#food-button').addEventListener('click', () => {
        window.foodOpenedOn = document.querySelector('.diary-date-btn').textContent;
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<div>Add Food to Diary</div><input placeholder="Search all foods"><button>SEARCH</button>';
        document.body.append(dialog);
      });
    </script>
  `);
  const defaultDateProvider = providerForFixture(page);
  const defaultDateFoodSearch = await defaultDateProvider.openFoodSearchDialog(page);
  const foodOpenedOn = await page.evaluate(() => window.foodOpenedOn);
  checkFixture("omitted food-search date navigates to today", () => {
    assert.equal(defaultDateFoodSearch.selected, true);
    assert.equal(defaultDateFoodSearch.normalizedDate, today);
    assert.equal(defaultDateFoodSearch.appliedDate, today);
    assert.equal(defaultDateFoodSearch.strategy, "arrow");
    assert.equal(defaultDateFoodSearch.steps, 1);
    assert.equal(foodOpenedOn, "Today", "FOOD must only be clicked after the reused diary reaches Today");
  });

  await page.setContent(`
    <style>button, table, tr, td { display: block; width: 220px; min-height: 20px; }</style>
    <nav>Dashboard Diary Trends Foods</nav>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">${yesterdayLabel}</button>
      ${mealSection("Breakfast", foodRow("Yesterday Food", 1))}
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
      <button id="food-button">FOOD</button>
    </main>
    <script>
      window.foodClickCount = 0;
      document.querySelector('#food-button').addEventListener('click', () => { window.foodClickCount += 1; });
    </script>
  `);
  const failedDefaultDateFoodSearch = await defaultDateProvider.openFoodSearchDialog(page);
  const failedDefaultDateFoodClicks = await page.evaluate(() => window.foodClickCount);
  const failedDefaultDateDialogCount = await page.locator("[role='dialog']").count();
  checkFixture("unverified default date blocks food search", () => {
    assert.equal(failedDefaultDateFoodSearch.selected, false);
    assert.equal(failedDefaultDateFoodClicks, 0, "an unverified Today transition must send zero FOOD clicks");
    assert.equal(failedDefaultDateDialogCount, 0, "an unverified Today transition must open zero dialogs");
  });

  await page.setContent(`
    <style>button, table, tr, td { display: block; width: 220px; min-height: 20px; }</style>
    <nav>Dashboard Diary Trends Foods</nav>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-next">Next</button>
      <button class="diary-date-btn">${yesterdayLabel}</button>
      ${mealSection("Breakfast", foodRow("Yesterday Food", 1))}
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
    </main>
    <script>
      document.querySelector('.diary-date-next').addEventListener('click', () => {
        document.querySelector('.diary-date-btn').textContent = 'Today';
        document.querySelector('.food-name').textContent = 'Today Food';
      });
    </script>
  `);
  const defaultDateStability = await defaultDateProvider.stabilityCheck({ includeFoodSearch: false });
  checkFixture("stability check proves today", () => {
    assert.equal(defaultDateStability.status, "ok");
    assert.equal(defaultDateStability.data.dateStatus.selected, true);
    assert.equal(defaultDateStability.data.checks.todaySelected, true);
  });

  await page.setContent(`
    <style>button, table, tr, td { display: block; width: 180px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-previous">Previous</button>
      <button class="diary-date-btn">Today</button>
      <div id="diary-rows">
        ${mealSection("Breakfast", foodRow("TODAY SENTINEL", 1))}
        ${mealSection("Lunch")}
        ${mealSection("Dinner")}
        ${mealSection("Snacks")}
        ${mealSection("Supplements")}
      </div>
    </main>
    <table id="unrelated-table"><tbody><tr><td>BACKGROUND 0</td></tr></tbody></table>
    <script>
      document.querySelector('.diary-date-previous').addEventListener('click', () => {
        // Cronometer can publish the new date label before replacing diary rows.
        document.querySelector('.diary-date-btn').textContent = ${JSON.stringify(yesterdayLabel)};
        // Other tables on a large SPA may mutate while the diary request is in
        // flight. That must not count as proof that diary rows refreshed.
        setTimeout(() => {
          document.querySelector('#unrelated-table td').textContent = 'BACKGROUND 1';
        }, 50);
        setTimeout(() => {
          document.querySelector('#diary-rows').innerHTML = ${JSON.stringify(`
            ${mealSection("Breakfast", foodRow("YESTERDAY SENTINEL", 2))}
            ${mealSection("Lunch")}
            ${mealSection("Dinner")}
            ${mealSection("Snacks")}
            ${mealSection("Supplements")}
          `)};
        }, 1250);
      });
    </script>
  `);

  const staleNavigationResult = await providerForFixture(page).listFoodEntries({ date: yesterday });
  checkFixture("date label/table synchronization", () => {
    assert.equal(staleNavigationResult.status, "ok");
    assert.equal(staleNavigationResult.data.dateStatus.displayedDateLabel, yesterdayLabel);
    assert.deepEqual(
      staleNavigationResult.data.entries.map((entry) => entry.name),
      ["YESTERDAY SENTINEL"],
      "a matching label is not proof until the requested date's diary rows replace the previous rows",
    );
  });

  await page.setContent(`
    <style>button, table, tr, td { display: block; width: 180px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-previous">Previous</button>
      <button class="diary-date-btn">Today</button>
      <div id="diary-rows">
        ${mealSection("Breakfast", foodRow("UNTRUSTED ROW FROM A DIFFERENT DATE", 3))}
        ${mealSection("Lunch")}
        ${mealSection("Dinner")}
        ${mealSection("Snacks")}
        ${mealSection("Supplements")}
      </div>
    </main>
    <script>
      document.querySelector('.diary-date-previous').addEventListener('click', () => {
        // Model the live incident: one requested previous-day click landed two days back.
        document.querySelector('.diary-date-btn').textContent = ${JSON.stringify(twoDaysAgoLabel)};
      });
    </script>
  `);

  const failedNavigationResult = await providerForFixture(page).listFoodEntries({ date: yesterday });
  checkFixture("failed navigation row suppression", () => {
    assert.equal(failedNavigationResult.status, "needs_manual_step");
    assert.equal(failedNavigationResult.data.dateStatus.selected, false);
    assert.equal(failedNavigationResult.data.count, 0);
    assert.deepEqual(
      failedNavigationResult.data.entries,
      [],
      "rows must not be extracted or mislabeled with the requested date after date navigation fails",
    );
  });

  await page.setContent(`
    <style>button, table, tr, td, [role="dialog"] { display: block; width: 180px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">Today</button>
      ${mealSection("Breakfast", foodRow("REAL BREAKFAST", 50))}
      <div class="pretty-dialog" role="dialog">
        <div>Add Food to Diary</div>
        <table><tbody>${foodRow("Orange Juice, Fresh", 272)}</tbody></table>
        <button>Breakfast</button>
        <button>ADD TO DIARY</button>
      </div>
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
    </main>
  `);

  const openEditorResult = await providerForFixture(page).listFoodEntries({ date: today });
  checkFixture("open food editor row exclusion", () => {
    assert.equal(openEditorResult.status, "ok");
    assert.equal(openEditorResult.data.structureVerified, true);
    const names = openEditorResult.data.entries.map((entry) => entry.name);
    assert.equal(
      names.includes("Orange Juice, Fresh"),
      false,
      "visible food-editor rows are drafts, not persisted diary rows, and cannot satisfy post-save verification",
    );
    assert.deepEqual(
      openEditorResult.data.entries.map(({ meal, name, amount, unit }) => ({ meal, name, amount, unit })),
      [{ meal: "Breakfast", name: "REAL BREAKFAST", amount: 50, unit: "g" }],
    );
  });

  await page.setContent(`
    <style>button, table, tr, td { display: block; width: 220px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">Today</button>
      ${mealSection("Breakfast", foodRow("REAL BREAKFAST", 50))}
      <table id="unrelated-nutrition-table"><tbody>
        ${foodRow("Orange Juice, Fresh", 272)}
      </tbody></table>
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
    </main>
  `);
  const tableScopedResult = await providerForFixture(page).listFoodEntries({ date: today });
  checkFixture("diary extraction table scoping", () => {
    assert.equal(tableScopedResult.status, "ok");
    assert.deepEqual(
      tableScopedResult.data.entries.map(({ meal, name, amount }) => ({ meal, name, amount })),
      [{ meal: "Breakfast", name: "REAL BREAKFAST", amount: 50 }],
      "a neighboring table must not inherit the previous diary meal heading",
    );
  });

  await page.setContent(`
    <style>table, tr, td { display: block; width: 220px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">Today</button>
      <table><tbody>
        <tr><td class="diary-group-title">Breakfast</td><td></td><td></td><td></td><td></td><td></td></tr>
        <tr id="breakfast-orange">${foodRow("Orange Juice, Fresh", 100).replace(/^<tr[^>]*>|<\/tr>$/g, "")}</tr>
        <tr><td class="diary-group-title">Lunch</td><td></td><td></td><td></td><td></td><td></td></tr>
        <tr><td class="diary-group-title">Dinner</td><td></td><td></td><td></td><td></td><td></td></tr>
        <tr><td class="diary-group-title">Snacks</td><td></td><td></td><td></td><td></td><td></td></tr>
        <tr><td class="diary-group-title">Supplements</td><td></td><td></td><td></td><td></td><td></td></tr>
        <tr id="supplements-orange">${foodRow("Orange Juice, Fresh", 100).replace(/^<tr[^>]*>|<\/tr>$/g, "")}</tr>
      </tbody></table>
    </main>
    <script>
      window.clickedMeal = '';
      window.clickedCellClass = '';
      document.querySelector('#breakfast-orange').addEventListener('click', () => { window.clickedMeal = 'Breakfast'; });
      document.querySelector('#supplements-orange').addEventListener('click', () => { window.clickedMeal = 'Supplements'; });
      document.querySelector('#breakfast-orange .food-name').addEventListener('click', event => { window.clickedCellClass = event.currentTarget.className; });
    </script>
  `);
  const scopedClick = await __clickDiaryFoodEntryRowForTests(page, {
    date: today,
    meal: "Breakfast",
    name: "Orange Juice, Fresh",
    amount: 100,
    unit: "g",
  }, TIME_ZONE);
  const clickedMeal = await page.evaluate(() => window.clickedMeal);
  const clickedCellClass = await page.evaluate(() => window.clickedCellClass);
  checkFixture("delete row meal scoping", () => {
    assert.equal(scopedClick.clicked, true);
    assert.equal(scopedClick.targetCorrelated, true);
    assert.equal(scopedClick.strategy, "exact-food-name-cell");
    assert.equal(clickedMeal, "Breakfast");
    assert.equal(clickedCellClass, "food-name", "selection must click the food-name cell, not a leading editable cell");
  });

  await page.setContent(`
    <style>table, tr, td, [role='dialog'], button { display: block; width: 220px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">Today</button>
      ${mealSection("Breakfast", foodRow("Orange Juice, Fresh", 272))}
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
    </main>
    <script>
      window.internalGwtSelection = false;
      window.deleteKeyCount = 0;
      document.querySelector('.food-name').addEventListener('click', () => { window.internalGwtSelection = true; });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Delete') return;
        window.deleteKeyCount += 1;
        if (!window.internalGwtSelection) return;
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<div>Delete Items?</div><div>Delete the selected entries?</div><button>OK</button>';
        document.body.append(dialog);
      });
    </script>
  `);
  const internalSelectionClick = await __clickDiaryFoodEntryRowForTests(page, {
    date: today,
    meal: "Breakfast",
    name: "Orange Juice, Fresh",
    amount: 272,
    unit: "g",
  }, TIME_ZONE);
  const internalSelectionProof = await __proveTargetedDiaryEntrySelectionForTests(page, {
    requestedDate: today,
    normalizedDate: today,
    currentDate: today,
    appliedDate: today,
    selected: true,
    strategy: "today",
    freshDocumentReloadVerified: true,
    roundTripVerified: true,
  }, internalSelectionClick);
  const deleteDialogVisible = await page.locator("[role='dialog']").getByText("Delete the selected entries?", { exact: true }).isVisible();
  const deleteKeyCount = await page.evaluate(() => window.deleteKeyCount);
  checkFixture("GWT internal row selection proof", () => {
    assert.equal(internalSelectionProof.selectedAfterClick.selectedEntryCount, 0, "the current GWT DOM exposes no stable selected-row class");
    assert.equal(internalSelectionProof.verified, true, "the exact confirmation safely proves Cronometer accepted the target selection");
    assert.equal(internalSelectionProof.strategy, "fresh-targeted-click-and-confirmation");
    assert.equal(internalSelectionProof.deleteTrigger?.strategy, "keyboard:Delete");
    assert.equal(deleteKeyCount, 1, "the proof must use exactly one stable Delete action");
    assert.equal(deleteDialogVisible, true);
  });

  await page.setContent(`
    <style>table, tr, td { display: block; width: 220px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">Today</button>
      ${mealSection("Breakfast", '<tr class="selected"><td></td><td>Orange Juice, Fresh</td><td>272</td><td>g</td></tr>')}
      ${mealSection("Lunch", '<tr aria-selected="true"><td></td><td>Unrelated Food</td><td>1</td><td>g</td></tr>')}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
    </main>
    <script>
      window.deleteKeyCount = 0;
      document.addEventListener('keydown', event => { if (event.key === 'Delete') window.deleteKeyCount += 1; });
    </script>
  `);
  const ambiguousSelectionProof = await __proveTargetedDiaryEntrySelectionForTests(page, {
    requestedDate: today,
    normalizedDate: today,
    currentDate: today,
    appliedDate: today,
    selected: true,
    strategy: "today",
    freshDocumentReloadVerified: true,
    roundTripVerified: true,
  }, { clicked: true, targetCorrelated: true, strategy: "exact-food-name-cell" });
  const ambiguousDeleteKeyCount = await page.evaluate(() => window.deleteKeyCount);
  checkFixture("ambiguous diary selection fails closed", () => {
    assert.equal(ambiguousSelectionProof.selectedAfterClick.selectedEntryCount, 2);
    assert.equal(ambiguousSelectionProof.verified, false);
    assert.equal(ambiguousSelectionProof.strategy, "not_verified");
    assert.equal(ambiguousDeleteKeyCount, 0, "multiple selected diary rows must send zero Delete commands");
  });

  await page.setContent(`
    <style>table, tr, td { display: block; width: 220px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">Today</button>
      ${mealSection("Breakfast", '<tr class="selected"><td></td><td>Orange Juice, Fresh</td><td>272</td><td>g</td></tr>')}
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
    </main>
    <script>
      window.deleteKeyCount = 0;
      document.addEventListener('keydown', event => { if (event.key === 'Delete') window.deleteKeyCount += 1; });
    </script>
  `);
  const unprovenFreshDocument = await __proveTargetedDiaryEntrySelectionForTests(page, {
    requestedDate: today,
    normalizedDate: today,
    currentDate: today,
    appliedDate: today,
    selected: true,
    strategy: "today",
    freshDocumentReloadVerified: false,
    roundTripVerified: true,
  }, { clicked: true, targetCorrelated: true, strategy: "exact-food-name-cell" });
  const unprovenRoundTrip = await __proveTargetedDiaryEntrySelectionForTests(page, {
    requestedDate: today,
    normalizedDate: today,
    currentDate: today,
    appliedDate: today,
    selected: true,
    strategy: "today",
    freshDocumentReloadVerified: true,
    roundTripVerified: false,
  }, { clicked: true, targetCorrelated: true, strategy: "exact-food-name-cell" });
  const unprovenDeleteKeyCount = await page.evaluate(() => window.deleteKeyCount);
  checkFixture("unproven delete document fails closed", () => {
    assert.equal(unprovenFreshDocument.verified, false);
    assert.equal(unprovenRoundTrip.verified, false);
    assert.equal(unprovenDeleteKeyCount, 0, "missing reload or round-trip proof must send zero Delete commands");
  });

  await page.setContent(`
    <style>table, tr, td { display: block; width: 220px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">Today</button>
      ${mealSection("Breakfast", foodRow("Orange Juice, Fresh", 272))}
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements")}
    </main>
    <script>
      window.deleteKeyCount = 0;
      document.addEventListener('keydown', event => { if (event.key === 'Delete') window.deleteKeyCount += 1; });
    </script>
  `);
  const baselineDeleteProvider = providerForFixture(page);
  baselineDeleteProvider.openDiaryForWrite = async () => ({
    requestedDate: today,
    normalizedDate: today,
    currentDate: today,
    appliedDate: today,
    selected: true,
    strategy: "today",
    freshDocumentReloadVerified: true,
    roundTripVerified: true,
  });
  const baselineMismatchDelete = await baselineDeleteProvider.runDeleteDiaryFoodEntry({
    date: today,
    meal: "Breakfast",
    name: "Orange Juice, Fresh",
    amount: 272,
    unit: "g",
    confirmName: "Orange Juice, Fresh",
    expectedExistingMatchCount: 2,
    confirmed: true,
    dryRun: false,
  });
  const baselineMismatchDeleteKeys = await page.evaluate(() => window.deleteKeyCount);
  checkFixture("delete baseline mismatch fails closed", () => {
    assert.equal(baselineMismatchDelete.status, "needs_manual_step");
    assert.equal(baselineMismatchDelete.data.actualExistingMatchCount, 1);
    assert.equal(baselineMismatchDelete.data.expectedExistingMatchCount, 2);
    assert.equal(baselineMismatchDelete.data.writeAttempted, false);
    assert.equal(baselineMismatchDeleteKeys, 0, "a stale delete baseline must send zero Delete commands");
  });

  await page.setContent(`
    <style>table, tr, td { display: block; width: 220px; min-height: 20px; }</style>
    <main id="diary">
      <div>Diary</div>
      <button class="diary-date-btn">Today</button>
      ${mealSection("Breakfast", foodRow("Orange Juice, Fresh", 100))}
      ${mealSection("Lunch")}
      ${mealSection("Dinner")}
      ${mealSection("Snacks")}
      ${mealSection("Supplements", `
        <tr id="stale-selected"><td><input id="stale-diary-checkbox" type="checkbox" checked></td><td>Unrelated Supplement</td><td>1</td><td>g</td><td>0</td><td>kcal</td></tr>
      `)}
    </main>
    <table id="outside-diary"><tbody><tr><td><input id="outside-checkbox" type="checkbox" checked> Outside selection</td></tr></tbody></table>
  `);
  const selectionReset = await __clearDiaryEntrySelectionsForTests(page);
  const diaryCheckboxChecked = await page.locator("#stale-diary-checkbox").isChecked();
  const outsideCheckboxChecked = await page.locator("#outside-checkbox").isChecked();
  checkFixture("stale diary selection reset", () => {
    assert.equal(selectionReset.before.selectedEntryCount, 1);
    assert.equal(selectionReset.cleared, true);
    assert.equal(selectionReset.checkedControlClicks, 1);
    assert.equal(diaryCheckboxChecked, false, "a preselected unrelated diary row must be cleared before target selection");
    assert.equal(outsideCheckboxChecked, true, "selection reset must stay scoped to structured diary tables");
  });

  const deleteInput = {
    date: today,
    meal: "Breakfast",
    name: "Orange Juice, Fresh",
    amount: 100,
    unit: "g",
  };
  const beforeDeleteEntries = [
    { meal: "Breakfast", name: "Orange Juice, Fresh", amount: 100, unit: "g" },
    { meal: "Lunch", name: "Apple", amount: 120, unit: "g" },
  ];
  const exactDeletion = __verifyDiaryFoodDeletionEffectForTests(
    beforeDeleteEntries,
    [beforeDeleteEntries[1]],
    deleteInput,
    TIME_ZONE,
  );
  const extraDeletion = __verifyDiaryFoodDeletionEffectForTests(
    beforeDeleteEntries,
    [],
    deleteInput,
    TIME_ZONE,
  );
  checkFixture("delete total-row delta", () => {
    assert.equal(exactDeletion.targetCountDelta.verified, true);
    assert.equal(exactDeletion.totalCountDelta.verified, true);
    assert.equal(exactDeletion.verified, true);
    assert.equal(extraDeletion.targetCountDelta.verified, true, "the intended target disappeared");
    assert.equal(extraDeletion.totalCountDelta.verified, false, "an unrelated extra deletion must be detected");
    assert.equal(extraDeletion.verified, false, "target-only verification cannot certify a multi-row delete");
  });

  const roundTripUrl = "https://fixture.test/write-date";
  const todayRows = `
    ${mealSection("Breakfast", foodRow("TODAY SENTINEL", 1))}
    ${mealSection("Lunch")}
    ${mealSection("Dinner")}
    ${mealSection("Snacks")}
    ${mealSection("Supplements")}
  `;
  const yesterdayRows = `
    ${mealSection("Breakfast", foodRow("YESTERDAY SENTINEL", 2))}
    ${mealSection("Lunch")}
    ${mealSection("Dinner")}
    ${mealSection("Snacks")}
    ${mealSection("Supplements")}
  `;
  await page.route(roundTripUrl, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><style>button,table,tr,td{display:block;width:220px;min-height:20px}</style>
      <main><div>Diary</div>
        <button class="diary-date-previous">Previous</button>
        <button class="diary-date-next">Next</button>
        <button class="diary-date-btn">Today</button>
        <div id="diary-rows">${todayRows}</div>
      </main>
      <script>
        document.querySelector('.diary-date-previous').onclick = () => {
          document.querySelector('.diary-date-btn').textContent = ${JSON.stringify(yesterdayLabel)};
          document.querySelector('#diary-rows').innerHTML = ${JSON.stringify(yesterdayRows)};
        };
        document.querySelector('.diary-date-next').onclick = () => {
          document.querySelector('.diary-date-btn').textContent = 'Today';
          document.querySelector('#diary-rows').innerHTML = ${JSON.stringify(todayRows)};
        };
      </script>`,
  }));
  await page.goto(roundTripUrl);
  const writeDateStatus = await providerForFixture(page).openDiaryForWrite(page, today);
  checkFixture("today write date round-trip proof", () => {
    assert.equal(writeDateStatus.selected, true);
    assert.equal(writeDateStatus.freshDocumentReloadVerified, true);
    assert.equal(writeDateStatus.roundTripVerified, true);
    assert.equal(writeDateStatus.displayedDateLabel, "Today");
  });
  await page.unroute(roundTripUrl);

  const lyingTodayUrl = "https://fixture.test/lying-today";
  await page.route(lyingTodayUrl, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><style>button,table,tr,td{display:block;width:220px;min-height:20px}</style>
      <main><div>Diary</div>
        <button class="diary-date-previous">Previous</button>
        <button class="diary-date-next">Next</button>
        <button class="diary-date-btn">Today</button>
        <div id="diary-rows">${todayRows}</div>
      </main>
      <script>
        // Reproduce the dangerous shape: the label changes but the diary/save
        // model never transitions. A Today label alone must not authorize Save.
        document.querySelector('.diary-date-previous').onclick = () => {
          document.querySelector('.diary-date-btn').textContent = ${JSON.stringify(yesterdayLabel)};
        };
        document.querySelector('.diary-date-next').onclick = () => {
          document.querySelector('.diary-date-btn').textContent = 'Today';
        };
      </script>`,
  }));
  await page.goto(lyingTodayUrl);
  const lyingWriteDateStatus = await providerForFixture(page).openDiaryForWrite(page, today);
  checkFixture("today label cannot authorize a write", () => {
    assert.equal(lyingWriteDateStatus.selected, false);
    assert.equal(lyingWriteDateStatus.freshDocumentReloadVerified, true);
    assert.equal(lyingWriteDateStatus.roundTripVerified, false);
    assert.match(lyingWriteDateStatus.warning, /without an observable diary-table refresh/i);
  });
  await page.unroute(lyingTodayUrl);

  await page.setContent(`
    <style>button,table,tr,td,[role=dialog]{display:block;width:220px;min-height:20px}</style>
    <main><div>Diary</div><button class="diary-date-btn">Today</button>
      <button id="food">FOOD</button>${todayRows}</main><div id="dialogs"></div>
    <script>document.querySelector('#food').onclick=()=>{
      document.querySelector('#dialogs').innerHTML='<div role="dialog">Add Food to Diary SEARCH</div>';
    };</script>
  `);
  const noReopenProvider = providerForFixture(page);
  let unexpectedOpenAppCalls = 0;
  noReopenProvider.openApp = async () => { unexpectedOpenAppCalls += 1; };
  const provenSearchStatus = await noReopenProvider.openFoodSearchDialogOnProvenDiary(page, {
    requestedDate: today,
    normalizedDate: today,
    currentDate: today,
    appliedDate: today,
    selected: true,
    strategy: "today",
    displayedDateLabel: "Today",
    freshDocumentReloadVerified: true,
    roundTripVerified: true,
  });
  checkFixture("food search stays on proven diary document", () => {
    assert.equal(provenSearchStatus.selected, true);
    assert.equal(unexpectedOpenAppCalls, 0, "opening the write search must not navigate or reopen the diary");
  });

  const normalizedOrangeJuice = {
    original: { query: "fresh orange juice", date: today, meal: "Breakfast", amount: 272, unit: "g" },
    query: "fresh orange juice",
    searchQueries: ["fresh orange juice"],
    date: today,
    meal: "Breakfast",
    amount: 272,
    unit: "g",
    selectedName: "Orange Juice, Fresh",
    selectedSource: "NCCDB",
    idempotencyKey: "fixture-orange-juice",
    validationIssues: [],
  };
  const persistedPage = ({ label = "Today", breakfast = "", supplements = "", editor = false }) => `<!doctype html>
    <style>button,table,tr,td,[role=dialog]{display:block;width:240px;min-height:20px}</style>
    <main><div>Diary</div><button class="diary-date-btn">${label}</button>
      <div id="diary-rows">
        ${mealSection("Breakfast", breakfast)}
        ${mealSection("Lunch")}
        ${mealSection("Dinner")}
        ${mealSection("Snacks")}
        ${mealSection("Supplements", supplements)}
      </div>
      ${editor ? `<div class="pretty-dialog" role="dialog"><button id="commit">ADD TO DIARY</button></div>
        <script>document.querySelector('#commit').onclick=()=>{
          document.querySelector('#diary-rows table tbody').insertAdjacentHTML('beforeend', ${JSON.stringify(foodRow("Orange Juice, Fresh", 272))});
        };</script>` : ""}
    </main>`;

  async function runPersistedWriteFixture(name, persistedHtml) {
    const url = `https://fixture.test/${name}`;
    let requestCount = 0;
    await page.route(url, (route) => {
      requestCount += 1;
      return route.fulfill({
        contentType: "text/html",
        body: requestCount === 1 ? persistedPage({ editor: true }) : persistedHtml,
      });
    });
    await page.goto(url);
    const result = await __commitAndVerifyPersistedFoodLogForTests(
      page,
      normalizedOrangeJuice,
      0,
      TIME_ZONE,
      { settleMs: 25, postReloadMs: 25, stableForMs: 300, snapshotTimeoutMs: 2500 },
    );
    await page.unroute(url);
    return { result, requestCount };
  }

  const wrongMealAmount = await runPersistedWriteFixture("wrong-meal-amount", persistedPage({
    supplements: foodRow("Orange Juice, Fresh", 100),
  }));
  checkFixture("commit reload rejects 100 g Supplements", () => {
    assert.equal(wrongMealAmount.requestCount, 2, "the commit path must force a new document request");
    assert.equal(wrongMealAmount.result.saved, true);
    assert.equal(wrongMealAmount.result.persistedStructureVerified, true);
    assert.equal(wrongMealAmount.result.countVerified, false);
    assert.equal(wrongMealAmount.result.countDelta.actualDelta, 0);
    assert.deepEqual(
      wrongMealAmount.result.afterDiary.entries.map(({ meal, name, amount, unit }) => ({ meal, name, amount, unit })),
      [{ meal: "Supplements", name: "Orange Juice, Fresh", amount: 100, unit: "g" }],
    );
  });

  const wrongDate = await runPersistedWriteFixture("wrong-date", persistedPage({
    label: yesterdayLabel,
    breakfast: foodRow("Orange Juice, Fresh", 272),
  }));
  checkFixture("commit reload rejects July-17-style landing", () => {
    assert.equal(wrongDate.result.saved, true);
    assert.equal(wrongDate.result.persistedDateStatus.selected, false);
    assert.equal(wrongDate.result.countVerified, false);
  });

  const exactPersisted = await runPersistedWriteFixture("exact-persisted", persistedPage({
    breakfast: foodRow("Orange Juice, Fresh", 272),
  }));
  checkFixture("commit reload accepts exact 272 g Breakfast", () => {
    assert.equal(exactPersisted.result.saved, true);
    assert.equal(exactPersisted.result.persistedStructureVerified, true);
    assert.equal(exactPersisted.result.countDelta.actualDelta, 1);
    assert.equal(exactPersisted.result.countVerified, true);
  });
} finally {
  await browser.close();
}

if (failures.length > 0) {
  throw new AggregateError(failures, `${failures.length} diary determinism regression fixture(s) failed`);
}

console.log("diary determinism DOM fixture tests passed");
