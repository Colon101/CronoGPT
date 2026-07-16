#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { __exerciseFoodEditorSafetyForTests } from "../dist/providers/browser.js";

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

  await page.setContent(`<div class="pretty-dialog" role="dialog">Add Food to Diary <input><input><button>Lunch</button><button>ADD</button></div><div class="pretty-dialog" role="dialog">Add Food to Diary <input><input><button>Lunch</button><button>ADD</button></div>`);
  const ambiguous = await __exerciseFoodEditorSafetyForTests(page, "Lunch");
  assert.equal(ambiguous.editorCount, 0, "multiple semantic food editors must not be used");
  assert.equal(ambiguous.committed, false);
} finally {
  await browser.close();
}
console.log("food editor DOM fixture tests passed");
