#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  __closeFoodDialogForTests,
  __clickFoodSearchResultForTests,
  __collectFoodSearchResultsForTests,
  __exerciseFoodEditorSafetyForTests,
  __fillFoodAmountForTests,
  __readFoodEditorIdentityForTests,
  __searchCurrentFoodDialogForTests,
  chooseFoodLogResult,
} from "../dist/providers/browser.js";

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`
    <style>.dialog{display:block;position:absolute;width:300px;height:200px;top:10px;left:10px}.menu{position:absolute;top:55px;left:10px}.hidden{display:none}.unrelated{display:none}button{display:block;width:100px;height:25px}</style>
    <div class="dialog" role="dialog"><div>Add Food to Diary</div><input><input><button class="meal dropdown-toggle">Breakfast</button><button class="unit">g</button><button class="commit">ADD TO DIARY</button></div>
    <div class="unrelated"><div>Unrelated Save</div><input><input><button>SAVE</button></div>
    <div class="menu hidden"><button class="lunch dropdown-item">Lunch</button></div>
    <button class="global-save">SAVE</button>
    <script>
      const meal = document.querySelector('.meal'), menu = document.querySelector('.menu');
      meal.onclick = () => menu.classList.remove('hidden');
      document.querySelector('.lunch').onclick = () => { meal.textContent = 'Lunch'; menu.classList.add('hidden'); };
      document.querySelector('.commit').onclick = () => document.body.dataset.committed = 'editor';
      document.querySelector('.global-save').onclick = () => document.body.dataset.committed = 'global';
    </script>`);
  const result = await __exerciseFoodEditorSafetyForTests(page, "Lunch");
  assert.equal(result.editorCount, 1);
  assert.equal(result.selected.selected, true);
  assert.equal(result.readback.matches, true);
  assert.equal(result.committed, true);
  assert.equal(await page.locator('body').getAttribute('data-committed'), 'editor');

  await page.setContent(`<style>.dialog{display:block;position:absolute;width:300px;height:200px;top:10px;left:10px}button,input{display:block;width:100px;height:25px}</style><div id="mount"></div>`);
  await page.evaluate(() => {
    setTimeout(() => {
      document.querySelector('#mount').innerHTML = '<div class="dialog" role="dialog"><div>Add Food to Diary</div><input><input><button class="meal dropdown-toggle">Lunch</button><button class="unit">g</button><button class="commit">ADD TO DIARY</button></div>';
      document.querySelector('.commit').onclick = () => document.body.dataset.committed = 'delayed-editor';
    }, 350);
  });
  const delayed = await __exerciseFoodEditorSafetyForTests(page, "Lunch", 1500);
  assert.equal(delayed.editorCount, 1, "the resolver must wait for an asynchronously mounted food editor");
  assert.equal(delayed.readback.matches, true);
  assert.equal(delayed.committed, true);
  assert.equal(await page.locator('body').getAttribute('data-committed'), 'delayed-editor');

  await page.setContent(`<style>.pretty-dialog,.popupContent{display:block;position:absolute;width:300px;height:200px;top:10px;left:10px}button,input{display:block;width:100px;height:25px}</style><div class="pretty-dialog"><div class="popupContent" role="dialog"><div>Add Food to Diary</div><input><input><button class="meal dropdown-toggle">Lunch</button><button>g</button><button class="commit">ADD TO DIARY</button></div></div><script>document.querySelector('.commit').onclick=()=>document.body.dataset.committed='nested-editor'</script>`);
  const nested = await __exerciseFoodEditorSafetyForTests(page, "Lunch");
  assert.equal(nested.editorCount, 1, "nested GWT dialog wrappers must resolve to one logical editor");
  assert.equal(nested.committed, true);
  assert.equal(await page.locator('body').getAttribute('data-committed'), 'nested-editor');

  await page.setContent(`<div class="pretty-dialog" role="dialog">Add Food to Diary <input><input><button>Lunch</button><button>ADD</button></div><div class="pretty-dialog" role="dialog">Add Food to Diary <input><input><button>Lunch</button><button>ADD</button></div>`);
  const ambiguous = await __exerciseFoodEditorSafetyForTests(page, "Lunch");
  assert.equal(ambiguous.editorCount, 0, "multiple semantic food editors must not be used");
  assert.equal(ambiguous.committed, false);

  await page.setContent(`
    <style>[role=dialog],input,button,table,tr,td{display:block;width:260px;min-height:20px}</style>
    <div role="dialog"><div>Add Food to Diary</div>
      <input id="food-search" type="text" placeholder="Search all foods" value="Banana">
      <button id="search-submit">SEARCH</button>
      <table class="crono-table"><tbody id="search-results">
        <tr class="table-header"><td>Description</td><td>Source</td></tr>
        <tr><td><span class="gwt-HTML">Banana</span></td><td class="source">NCCDB</td></tr>
      </tbody></table>
    </div>
    <script>
      const searchInput = document.querySelector('#food-search');
      window.searchEvents = { keydown: 0, input: 0, submissions: 0 };
      searchInput.addEventListener('keydown', () => window.searchEvents.keydown++);
      searchInput.addEventListener('input', () => window.searchEvents.input++);
      document.querySelector('#search-submit').addEventListener('click', () => {
        window.searchEvents.submissions++;
        document.querySelector('#search-results').innerHTML =
          '<tr class="table-header"><td>Description</td><td>Source</td></tr>' +
          '<tr><td><span class="gwt-HTML">Orange Juice, Fresh</span></td><td class="source">NCCDB</td></tr>';
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') document.querySelector('[role="dialog"]')?.remove();
      });
    </script>
  `);
  const oneShotSearch = await __searchCurrentFoodDialogForTests(page, "fresh orange juice", 10);
  const searchEvents = await page.evaluate(() => window.searchEvents);
  assert.deepEqual(oneShotSearch.map(({ name, source }) => ({ name, source })), [
    { name: "Orange Juice, Fresh", source: "NCCDB" },
  ]);
  assert.ok(searchEvents.keydown >= 1, "food search must use real keyboard events");
  assert.ok(searchEvents.input >= 1, "food search must emit input events");
  assert.equal(searchEvents.submissions, 1, "one food query must produce exactly one search submission");
  const escapedSearchDialog = await __closeFoodDialogForTests(page);
  assert.deepEqual(escapedSearchDialog, { closed: true, strategy: "escape" });
  assert.equal(await page.locator("[role='dialog']").count(), 0, "completed search must leave a reusable page modal-free");

  await page.setContent(`
    <div role="dialog"><div>Add Food to Diary</div>
      <input placeholder="Search all foods"><button>SEARCH</button>
    </div>
  `);
  const reloadedSearchDialog = await __closeFoodDialogForTests(page);
  assert.deepEqual(reloadedSearchDialog, { closed: true, strategy: "reload" }, "a food dialog that ignores Escape must be cleared by reload");

  await page.setContent(`
    <div role="dialog"><div>Search saved reports</div>
      <input placeholder="Search records"><button>SEARCH</button>
    </div>
  `);
  const unrelatedSearchDialog = await __closeFoodDialogForTests(page);
  assert.deepEqual(unrelatedSearchDialog, { closed: true, strategy: "not-open" }, "generic search dialogs must not be mistaken for food UI");
  assert.equal(await page.locator("[role='dialog']").count(), 1, "non-food dialogs must remain untouched");

  await page.setContent(`
    <style>[role=dialog],table,tr,td{display:block;width:260px;min-height:20px}</style>
    <div role="dialog"><div>Add Food to Diary</div><div class="results-container"><table class="crono-table">
      <tr class="table-header"><td>Description</td><td>Source</td></tr>
      <tr id="duplicate-1"><td><span class="gwt-HTML">Banana</span></td><td class="source">NCCDB</td></tr>
      <tr id="duplicate-2"><td><span class="gwt-HTML">Banana</span></td><td class="source">NCCDB</td></tr>
    </table></div></div>
    <script>document.querySelectorAll('tr:not(.table-header)').forEach(row=>row.onclick=()=>document.body.dataset.clicked=row.id)</script>
  `);
  const duplicateRows = await __collectFoodSearchResultsForTests(page);
  assert.equal(duplicateRows.length, 2, "visible duplicate click targets must not be merged");
  assert.equal(chooseFoodLogResult({ query: "Banana" }, duplicateRows).status, "needs_manual_step");
  assert.equal(
    await __clickFoodSearchResultForTests(page, "Banana", "NCCDB"),
    false,
    "an indistinguishable duplicate name/source must never click the first row",
  );
  assert.equal(await page.locator("body").getAttribute("data-clicked"), null);

  await page.setContent(`
    <style>[role=dialog],table,tr,td{display:block;width:260px;min-height:20px}</style>
    <div role="dialog"><div>Add Food to Diary</div><div class="results-container"><table class="crono-table">
      <tr class="table-header"><td>Description</td><td>Source</td></tr>
      <tr id="nccdb"><td><span class="gwt-HTML">Banana</span></td><td class="source">NCCDB</td></tr>
      <tr id="crdb"><td><span class="gwt-HTML">Banana</span></td><td class="source">CRDB</td></tr>
    </table></div></div>
    <script>document.querySelectorAll('tr:not(.table-header)').forEach(row=>row.onclick=()=>document.body.dataset.clicked=row.id)</script>
  `);
  const sourceRows = await __collectFoodSearchResultsForTests(page);
  const pinnedSource = chooseFoodLogResult({
    query: "Banana",
    selectedName: "Banana",
    selectedSource: "CRDB",
    matchPolicy: "selected_only",
  }, sourceRows);
  assert.equal(pinnedSource.status, "ok");
  assert.equal(await __clickFoodSearchResultForTests(page, "Banana", "CRDB"), true);
  assert.equal(await page.locator("body").getAttribute("data-clicked"), "crdb");

  await page.setContent(`
    <style>#amount-editor,input,button{display:block;width:200px;height:25px}</style>
    <div id="amount-editor"><input class="text-box" value="100"><button>next</button></div>
    <script>
      const input=document.querySelector('input');
      window.amountEvents={input:0,keydown:0,blur:0};
      input.addEventListener('input',()=>window.amountEvents.input++);
      input.addEventListener('keydown',()=>window.amountEvents.keydown++);
      input.addEventListener('blur',()=>window.amountEvents.blur++);
    </script>
  `);
  const amountFill = await __fillFoodAmountForTests(page, "#amount-editor", 272);
  const amountEvents = await page.evaluate(() => window.amountEvents);
  assert.equal(amountFill.filled, true);
  assert.equal(amountFill.actualValue, "272");
  assert.equal(amountFill.blurred, true);
  assert.ok(amountEvents.input >= 1, "amount must emit real input events");
  assert.ok(amountEvents.keydown >= 1, "amount must emit real keyboard events");
  assert.ok(amountEvents.blur >= 1, "amount must blur before readback");

  await page.setContent(`
    <style>#identity,.food-search-name{display:block;width:240px;height:25px}</style>
    <div id="identity"><div class="food-search-name">Banana</div><div>NCCDB</div></div>
  `);
  const matchingIdentity = await __readFoodEditorIdentityForTests(page, "#identity", "Banana", "NCCDB");
  const wrongSourceIdentity = await __readFoodEditorIdentityForTests(page, "#identity", "Banana", "CRDB");
  assert.equal(matchingIdentity.matches, true);
  assert.equal(wrongSourceIdentity.matches, false, "a visible different source must fail the editor identity gate");
} finally {
  await browser.close();
}
console.log("food editor DOM fixture tests passed");
