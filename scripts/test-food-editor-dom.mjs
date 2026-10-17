#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  BrowserCronometerProvider,
  __addRecipeIngredientForTests,
  __closeFoodDialogForTests,
  __dismissSavedItemSuccessNoticeForTests,
  __clickFoodSearchResultForTests,
  __collectFoodSearchResultsForTests,
  __exerciseFoodEditorSafetyForTests,
  __fillFoodAmountForTests,
  __fillFoodUnitForTests,
  __fillRecipeBasicsForTests,
  __fillRecipeIngredientFieldsForTests,
  __fillRecipeCookedWeightForTests,
  __extractCustomRecipeDetailForTests,
  __readFoodEditorIdentityForTests,
  __removeRecipeIngredientForTests,
  __recipeEditIngredientsVerifiedForTests,
  __searchCurrentFoodDialogForTests,
  chooseFoodLogResult,
} from "../dist/providers/browser.js";

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<style>#background-unit{width:8px;height:12px}#diary-unit-editor{width:400px;height:200px}.dropdown-menu{display:none}</style>
    <table><tr><td id="background-unit">g</td></tr></table>
    <div id="diary-unit-editor"><button class="dropdown-btn dropdown-toggle" id="diary-unit">full recipe — 807g</button></div>
    <div class="dropdown-menu"><a class="gwt-Anchor dropdown-item" href="javascript:void(0)">g</a><a class="gwt-Anchor dropdown-item">full recipe — 807g</a></div>
    <script>(()=>{window.backgroundDiaryUnitClicked=false;
      const editor=document.querySelector('#diary-unit-editor'),unit=document.querySelector('#diary-unit'),menu=document.querySelector('.dropdown-menu');
      document.querySelector('#background-unit').onclick=()=>{window.backgroundDiaryUnitClicked=true;editor.style.display='none'};
      unit.onclick=()=>setTimeout(()=>menu.style.display='block',500);
      menu.querySelector('a').onclick=()=>{setTimeout(()=>unit.textContent='g',300);menu.style.display='none'};
    })();</script>`);
  const diaryRecipeUnit=await __fillFoodUnitForTests(page,'#diary-unit-editor','g');
  assert.equal(diaryRecipeUnit.filled,true,JSON.stringify(diaryRecipeUnit));
  assert.equal(await page.locator('#diary-unit').innerText(),'g');
  assert.equal(await page.evaluate(()=>window.backgroundDiaryUnitClicked),false,'recipe gram selection must ignore background nutrition units and wait for the actual dropdown');
  await page.setContent(`<table><tr><td>g</td></tr></table><div id="missing-unit-editor"><button class="dropdown-btn dropdown-toggle">full recipe — 807g</button></div><div class="dropdown-menu"><a class="dropdown-item">full recipe — 807g</a></div>`);
  assert.equal((await __fillFoodUnitForTests(page,'#missing-unit-editor','g')).filled,false,'a full-recipe unit containing a gram annotation is not a gram option');
  await page.setContent(`<div class="gwt-DialogBox" role="dialog">Message <div>Successfully deleted Test Food</div><button>OK</button></div><button id="next-food">Next saved food</button><script>document.querySelector('[role=dialog] button').onclick=()=>document.querySelector('[role=dialog]').remove();document.querySelector('#next-food').onclick=()=>window.nextFoodOpened=true</script>`);
  assert.equal((await __dismissSavedItemSuccessNoticeForTests(page)).dismissed, true);
  await page.locator('#next-food').click();
  assert.equal(await page.evaluate(()=>window.nextFoodOpened),true,"a completed delete notice must not block the next food editor");
  await page.setContent(`<div class="gwt-DialogBox" role="dialog">Message <div>This food is used by existing recipes. Delete or retire it?</div><button>OK</button></div>`);
  assert.equal((await __dismissSavedItemSuccessNoticeForTests(page)).dismissed, false,"dependency confirmation is not a success notice");
  assert.equal(await page.getByRole('dialog').count(),1);
  await page.setContent(`
    <table><tr><td><table>
      <tr id="butter"><td><div>Butter, Salted</div></td><td>NCCDB</td><td>16.15</td><td>g</td><td><img alt="Delete" title="Delete" width="16" height="16"></td></tr>
      <tr id="banana"><td><div>Banana, raw</div></td><td>CNF</td><td>385.7</td><td>g</td><td><img alt="Delete" title="Delete" width="16" height="16"></td></tr>
    </table></td></tr></table>
    <script>document.querySelectorAll('img').forEach(img=>img.onclick=()=>img.closest('tr').remove())</script>
  `);
  assert.equal((await __removeRecipeIngredientForTests(page, "Butter, Salted", "NCCDB")).removed, true);
  assert.equal(await page.locator('#banana').count(), 1, "removing the butter must preserve other ingredients and ignore ancestor table rows");
  await page.setContent(`<table><tr><td>Butter, Salted</td><td>NCCDB</td><td><img alt="Delete" width="16" height="16"></td></tr><tr><td>Butter, Salted</td><td>NCCDB</td><td><img alt="Delete" width="16" height="16"></td></tr></table>`);
  assert.equal((await __removeRecipeIngredientForTests(page, "Butter, Salted", "NCCDB")).removed, false, "ambiguous ingredient rows must not be deleted");
  assert.equal(await page.getByRole('img', { name: 'Delete', exact: true }).count(), 2);
  const originalIngredients = { name: "Recipe", ingredientsStatus: "parsed", ingredients: [
    { name: "Banana, raw", database: "CNF", amount: 385.7, unit: "g" },
    { name: "Butter, Salted", database: "NCCDB", amount: 16.15, unit: "g" },
  ] };
  const swappedIngredients = { ...originalIngredients, ingredients: [originalIngredients.ingredients[0], { name: "Butter, Unsalted", database: "NCCDB", amount: 16.15, unit: "g" }] };
  const additionProof = [{ status: "ok", selectedCandidate: { name: "Butter, Unsalted", source: "NCCDB" }, ingredient: { query: "unsalted butter", amount: 16.15, unit: "g" } }];
  assert.equal(__recipeEditIngredientsVerifiedForTests(originalIngredients, swappedIngredients, additionProof, [1]), true);
  assert.equal(__recipeEditIngredientsVerifiedForTests(originalIngredients, { ...swappedIngredients, ingredients: [...swappedIngredients.ingredients, originalIngredients.ingredients[1]] }, additionProof, [1]), false, "a swap must not leave both butter entries");
  assert.equal(__recipeEditIngredientsVerifiedForTests(originalIngredients, { ...swappedIngredients, ingredients: [{ ...swappedIngredients.ingredients[0], amount: 400 }, swappedIngredients.ingredients[1]] }, additionProof, [1]), false, "editing butter must not silently change a retained ingredient");
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

  // A hidden old popup must not hide the new ingredient dialog. Its input can
  // arrive after the old 2.5-second deadline, and the recipe title is already
  // present before any real search results arrive.
  await page.setContent(`
    <style>input,button,table,tr,td{display:block;width:260px;min-height:24px}</style>
    <h1>Chocolate Banana Bread</h1>
    <div role="dialog"><div>Add Ingredients</div><button id="late-search">SEARCH</button>
      <div id="late-input"></div><div class="results-container"><table class="crono-table"><tbody id="late-results"></tbody></table></div>
    </div>
    <div class="pretty-dialog" style="display:none"><input placeholder="Search all foods"><button>SEARCH</button></div>
    <script>
      window.ingredientSearchModel='';window.ingredientSearchSubmissions=0;
      setTimeout(()=>{
        const input=document.createElement('input');input.placeholder='Search all foods';
        let typed=false; input.onkeydown=()=>typed=true;
        input.oninput=()=>{if(typed)window.ingredientSearchModel=input.value};
        document.querySelector('#late-input').append(input);
      },3200);
      document.querySelector('#late-search').onclick=()=>{
        window.ingredientSearchSubmissions++;
        setTimeout(()=>{
          document.querySelector('#late-results').innerHTML=window.ingredientSearchModel==='Banana'
            ? '<tr><td>Banana</td><td class="source">NCCDB</td></tr>' : '<tr><td>No foods found</td></tr>';
        },650);
      };
    </script>
  `);
  const lateIngredients = await __searchCurrentFoodDialogForTests(page,"Banana",20);
  assert.deepEqual(lateIngredients.map(({name,source})=>({name,source})),[{name:"Banana",source:"NCCDB"}]);
  assert.equal(await page.evaluate(()=>window.ingredientSearchSubmissions),1);

  // Food-search tabs persist across dialog openings. Recipe ingredients must
  // switch away from a stale Custom tab for official foods, then switch back
  // for a pinned custom food without changing the selected source.
  const mountRecipeSearch = async (options = {}) => {
    await page.setContent(`
      <style>input,button{min-width:100px;min-height:24px}.pretty-dialog{width:700px;min-height:250px}</style>
      <h1>Recipe scope fixture</h1><button id="add-ingredients">ADD INGREDIENTS</button>
      <table><tbody id="recipe-ingredients"><tr><th>Description</th><th>Database</th><th id="recipe-amount-header">Amount</th><th>Unit</th><th>Energy</th><th>Weight</th></tr></tbody></table>
    `);
    await page.evaluate(({ missingScope, ignoredScope, customServingUnit, storedCustomAmount, missingAmountEditor, duplicateCustomRow, changedReadbackUnit, ignoredReadbackHeader, mutatedAfterHeaderAmount }) => {
      window.stickyFoodScope = "Custom";
      window.recipeSearches = [];
      window.recipeAdds = [];
      window.preciseRowReads = 0;
      window.preciseRowWrites = 0;
      window.preciseRowKeyPresses = 0;
      document.querySelector('#add-ingredients').onclick = () => {
        const dialog = document.createElement('div');
        dialog.className = 'pretty-dialog';dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<div>Add Ingredients</div><div role="tablist"></div><input placeholder="Search all foods"><button id="scope-search">SEARCH</button><div class="results-container"><table class="crono-table"><tbody></tbody></table></div>';
        document.body.append(dialog);
        for (const scope of ['All', 'Custom', 'Favorites'].filter((scope) => scope !== missingScope)) {
          const button = document.createElement('button');button.setAttribute('role', 'tab');button.textContent = scope;
          button.setAttribute('aria-selected', String(scope === window.stickyFoodScope));
          button.onclick = () => {
            if (scope === ignoredScope) return;
            window.stickyFoodScope = scope;
            dialog.querySelectorAll('[role="tab"]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.textContent === scope)));
          };
          dialog.querySelector('[role="tablist"]').append(button);
        }
        dialog.querySelector('#scope-search').onclick = () => {
          const query = dialog.querySelector('input').value;
          window.recipeSearches.push({ scope: window.stickyFoodScope, query });
          const foods = window.stickyFoodScope === 'Custom'
            ? [{ name: 'Impact Whey Protein', source: 'Custom Food' }]
            : [{ name: 'Milk, 1% Fat, Lowfat', source: 'CRDB' }, { name: 'Milk, 1% Fat, Lowfat', source: 'NCCDB' }];
          const table = dialog.querySelector('tbody');
          table.innerHTML = '<tr class="table-header"><td>Description</td><td>Source</td></tr>';
          for (const food of foods) {
            const row = document.createElement('tr');
            row.innerHTML = '<td><span class="gwt-HTML"></span></td><td class="source"></td>';
            row.querySelector('.gwt-HTML').textContent = food.name;row.querySelector('.source').textContent = food.source;
            row.onclick = () => {
              const unit = food.source === 'Custom Food' && customServingUnit ? customServingUnit : 'g';
              dialog.innerHTML = '<div class="food-search-name"></div><div class="selected-source"></div><input class="text-box" aria-label="Amount" value="100"><button class="dropdown-btn dropdown-toggle"></button><button id="scope-add">ADD</button>';
              dialog.querySelector('.food-search-name').textContent = food.name;dialog.querySelector('.selected-source').textContent = food.source;
              const unitButton = dialog.querySelector('.dropdown-toggle');unitButton.textContent = unit;
              unitButton.onclick = () => {
                const menu = document.createElement('div');menu.className = 'dropdown-menu';
                const option = document.createElement('div');option.className = 'dropdown-item';option.textContent = unit;
                option.onclick = () => menu.remove();menu.append(option);dialog.append(menu);
              };
              if (customServingUnit && food.source === 'Custom Food') {
                const input = dialog.querySelector('input');
                input.onblur = () => input.value = (Math.trunc(Number(input.value) * 10000) / 10000).toFixed(4);
              }
              dialog.querySelector('#scope-add').onclick = () => {
                const amount = Number(dialog.querySelector('input').value);
                const added = { name: food.name, source: food.source, amount };
                window.recipeAdds.push(added);
                const saved = document.createElement('tr');
                let preciseAmount = storedCustomAmount ?? amount;
                const displayedAmount = customServingUnit ? preciseAmount.toFixed(2) : String(amount);
                for (const text of [food.name, food.source, displayedAmount, unit, '100', customServingUnit ? 'Unknown' : amount + ' g']) {
                  const cell = document.createElement('td');cell.textContent = text;saved.append(cell);
                }
                if (customServingUnit && !missingAmountEditor) {
                  const amountCell = saved.children[2];
                  amountCell.onclick = () => {
                    if (amountCell.querySelector('input')) return;
                    window.preciseRowReads++;
                    if (changedReadbackUnit) saved.children[3].textContent = changedReadbackUnit;
                    const input = document.createElement('input');input.className = 'number-box';input.value = preciseAmount.toFixed(4);
                    input.oninput = () => window.preciseRowWrites++;
                    input.onkeydown = () => window.preciseRowKeyPresses++;
                    // The real widget ignores Escape, Enter, Tab and ordinary
                    // blur. Only its own Amount column header ends this edit.
                    document.querySelector('#recipe-amount-header').onclick = () => {
                      if (ignoredReadbackHeader) return;
                      if (mutatedAfterHeaderAmount !== undefined) preciseAmount = mutatedAfterHeaderAmount;
                      amountCell.textContent = displayedAmount;
                    };
                    amountCell.textContent = '';amountCell.append(input);input.focus();
                  };
                }
                document.querySelector('#recipe-ingredients').append(saved);dialog.remove();
                if (duplicateCustomRow) document.querySelector('#recipe-ingredients').append(saved.cloneNode(true));
              };
            };
            table.append(row);
          }
        };
      };
    }, options);
  };
  const milkIngredient = { query: 'lowfat milk', selectedName: 'Milk, 1% Fat, Lowfat', selectedSource: 'NCCDB', amount: 300, unit: 'g' };
  const wheyIngredient = { query: 'whey', selectedName: 'Impact Whey Protein', selectedSource: 'Custom Food', amount: 60, unit: 'g' };
  await mountRecipeSearch();
  const milkAdded = await __addRecipeIngredientForTests(page, milkIngredient);
  assert.equal(milkAdded.status, 'ok', JSON.stringify(milkAdded));
  const wheyAdded = await __addRecipeIngredientForTests(page, wheyIngredient);
  assert.equal(wheyAdded.status, 'ok', JSON.stringify(wheyAdded));
  assert.deepEqual(await page.evaluate(() => window.recipeSearches), [
    { scope: 'All', query: milkIngredient.selectedName },
    { scope: 'Custom', query: wheyIngredient.selectedName },
  ]);
  assert.deepEqual(await page.evaluate(() => window.recipeAdds), [
    { name: milkIngredient.selectedName, source: 'NCCDB', amount: 300 },
    { name: wheyIngredient.selectedName, source: 'Custom Food', amount: 60 },
  ]);
  for (const options of [{ missingScope: 'All' }, { ignoredScope: 'All' }]) {
    await mountRecipeSearch(options);
    const blocked = await __addRecipeIngredientForTests(page, milkIngredient);
    assert.equal(blocked.status, 'search_scope_not_selected', JSON.stringify(blocked));
    assert.deepEqual(await page.evaluate(() => window.recipeSearches), [], 'an unavailable or unchanged scope must prevent searching');
    assert.deepEqual(await page.evaluate(() => window.recipeAdds), [], 'a failed scope selection must not add an ingredient');
  }
  await mountRecipeSearch({ missingScope: 'Custom' });
  const missingCustomScope = await __addRecipeIngredientForTests(page, wheyIngredient);
  assert.equal(missingCustomScope.status, 'search_scope_not_selected', JSON.stringify(missingCustomScope));
  assert.deepEqual(await page.evaluate(() => window.recipeSearches), [], 'custom ingredients must not fall back to a different scope');

  const convertedWhey = { ...wheyIngredient, amount: 43 };
  await mountRecipeSearch({ customServingUnit: '31 g' });
  const preciseWhey = await __addRecipeIngredientForTests(page, convertedWhey);
  assert.equal(preciseWhey.status, 'ok', JSON.stringify(preciseWhey));
  assert.equal(await page.locator('#recipe-ingredients tr').nth(1).locator('td').nth(2).innerText(), '1.39', 'the recipe display deliberately rounds the committed amount');
  assert.equal(await page.evaluate(() => window.preciseRowReads), 2, 'verification must reopen the added row and confirm its saved amount survives unchanged header closure');
  assert.equal(await page.evaluate(() => window.preciseRowWrites), 0, 'precision readback must not type or submit any value');
  assert.equal(await page.evaluate(() => window.preciseRowKeyPresses), 0, 'precision readback must use the actual row and same-table header UI, without keyboard guesses');
  await page.evaluate(() => {
    const input = document.createElement('input');input.className = 'text-box';input.value = 'Recipe scope fixture';document.body.prepend(input);
  });
  const persistedWhey = await __extractCustomRecipeDetailForTests(page);
  assert.equal(persistedWhey.ingredients[0].amount, 1.387);
  assert.deepEqual(persistedWhey.ingredients[0].amountReadback, { source: 'row_editor', displayedAmount: 1.39, actualValue: '1.3870' });
  assert.equal(await page.evaluate(() => window.preciseRowReads), 4, 'saved recipe extraction must independently reread the current row and confirm unchanged header closure');
  assert.equal(await page.evaluate(() => window.preciseRowWrites), 0);
  for (const options of [{ storedCustomAmount: 1.38 }, { missingAmountEditor: true }, { duplicateCustomRow: true }, { changedReadbackUnit: '30 g' }, { ignoredReadbackHeader: true }, { mutatedAfterHeaderAmount: 1.38 }]) {
    await mountRecipeSearch({ customServingUnit: '31 g', ...options });
    const wrongWhey = await __addRecipeIngredientForTests(page, convertedWhey);
    assert.equal(wrongWhey.status, 'added_ingredient_not_verified', JSON.stringify(wrongWhey));
    assert.equal(await page.evaluate(() => window.preciseRowWrites), 0, 'failed verification must not repair or commit the value it reads');
    assert.equal(await page.evaluate(() => window.preciseRowKeyPresses), 0);
  }

  // The ingredient control depends on the widget model, not the visible DOM
  // value. Real typing and blur must commit all recipe fields before adding.
  await page.setContent(`
    <style>input,button{display:block;width:260px;height:28px}</style>
    <input class="text-box" id="recipe-name"><input class="text-box" id="recipe-serving"><input class="number-box" id="recipe-count">
    <button id="recipe-add" disabled>ADD INGREDIENTS</button>
    <script>
      window.recipeModel={};
      for(const input of document.querySelectorAll('input')){
        let typed=false;input.onkeydown=()=>typed=true;
        input.onblur=()=>{
          if(typed)window.recipeModel[input.id]=input.value;
          document.querySelector('#recipe-add').disabled=Object.keys(window.recipeModel).length!==3;
        };
      }
    </script>
  `);
  const typedBasics=await __fillRecipeBasicsForTests(page,{name:"Chocolate Banana Bread",servingName:"g",servings:807,ingredients:[]});
  assert.equal(typedBasics.nameFilled,true);
  assert.equal(typedBasics.servingNameFilled,true);
  assert.equal(typedBasics.servingsFilled,true);
  assert.equal(await page.locator('#recipe-add').isEnabled(),true);
  assert.deepEqual(await page.evaluate(()=>window.recipeModel),{"recipe-name":"Chocolate Banana Bread","recipe-serving":"g","recipe-count":"807"});

  // A small background 'g' label used to win over the real menu option and
  // dismiss the ingredient dialog. Unit selection must keep this editor open.
  await page.setContent(`
    <style>
      #background-g{position:absolute;left:5px;top:5px;width:6px;height:12px;font-size:9px}
      .pretty-dialog{position:absolute;left:100px;top:80px;width:400px;height:300px}
      .food-search-name,input,button{display:block;width:240px;min-height:28px}
      .dropdown-menu{position:absolute;left:100px;top:190px;width:240px}
      .dropdown-item{display:block;width:220px;height:32px}
    </style>
    <div id="background-g">g</div>
    <div class="pretty-dialog" role="dialog"><div class="food-search-name">Banana, raw</div>
      <input class="text-box" aria-label="Amount" value="1">
      <button class="dropdown-btn dropdown-toggle" id="ingredient-unit">250ml mashed — 238g</button>
      <button id="commit-ingredient">ADD</button>
    </div>
    <div class="popupContent dropdown-menu" role="listbox" style="display:none"><div class="dropdown-item" role="option">g</div></div>
    <script>
      (()=>{
      window.backgroundUnitClicked=false;window.ingredientModel={};
      const editor=document.querySelector('.pretty-dialog'),menu=document.querySelector('.dropdown-menu'),unit=document.querySelector('#ingredient-unit'),amount=editor.querySelector('input');
      document.querySelector('#background-g').onclick=()=>{window.backgroundUnitClicked=true;editor.style.display='none'};
      unit.onclick=()=>menu.style.display='block';
      menu.querySelector('[role=option]').onclick=()=>{unit.textContent='g';window.ingredientModel.unit='g';menu.style.display='none'};
      let typed=false;amount.onkeydown=()=>typed=true;
      amount.onblur=()=>{if(typed)window.ingredientModel.amount=Number(amount.value)};
      document.querySelector('#commit-ingredient').onclick=()=>window.savedIngredient=window.ingredientModel.amount+' '+window.ingredientModel.unit;
      })();
    </script>
  `);
  const ingredientFields=await __fillRecipeIngredientFieldsForTests(page,385.7,"g","Banana, raw");
  assert.equal(ingredientFields.unit.filled,true,JSON.stringify(ingredientFields));
  assert.equal(ingredientFields.amount?.filled,true);
  assert.equal(await page.locator('.pretty-dialog').isVisible(),true);
  assert.equal(await page.evaluate(()=>window.backgroundUnitClicked),false);
  await page.locator('#commit-ingredient').click();
  assert.equal(await page.evaluate(()=>window.savedIngredient),"385.7 g");

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

  // Cronometer exposes cooked weight behind Advanced Info and an unlabelled
  // gram-only modal. Original weight must not mask the saved cooked weight.
  await page.setContent(`
    <style>input,button,.row{display:block;width:240px;min-height:24px}.pretty-dialog{display:none}</style>
    <input class="text-box" value="Recipe fixture">
    <input class="text-box" value="bowl"><input class="number-box" value="1">
    <button id="advanced" aria-expanded="false">Advanced Info</button>
    <div id="advanced-fields" hidden>
      <div>Original Recipe Weight 239 g</div>
      <div class="row"><div>Cooked Recipe Weight</div><button id="set-weight">Set Cooked Recipe Weight</button></div>
    </div>
    <div class="pretty-dialog"><div>Set Cooked Weight</div><div>Cooked Weight</div>
      <input id="weight" class="text-box"><div>g</div><button id="save-weight">Save</button>
    </div>
    <script>
      (()=>{
      const advanced=document.querySelector('#advanced'), fields=document.querySelector('#advanced-fields');
      const dialog=document.querySelector('.pretty-dialog'), input=document.querySelector('#weight');
      const button=document.querySelector('#set-weight');
      let typed=false, blurred=false;
      advanced.onclick=()=>{fields.hidden=false;advanced.setAttribute('aria-expanded','true')};
      button.onclick=()=>{dialog.style.display='block'};
      input.onkeydown=()=>typed=true; input.onblur=()=>blurred=true;
      document.querySelector('#save-weight').onclick=()=>{
        if(typed&&blurred){button.textContent=input.value+' g';dialog.style.display='none'}
      };
      })();
    </script>
  `);
  assert.equal(await __fillRecipeCookedWeightForTests(page, 0.321, "kg"), true);
  assert.equal(await page.locator('#set-weight').innerText(), "321 g");
  assert.equal(await __fillRecipeCookedWeightForTests(page, 0.3, "kg"), true, "the existing weight button must remain editable");
  assert.equal(await page.locator('#set-weight').innerText(), "300 g");
  assert.equal(await __fillRecipeCookedWeightForTests(page, 321, "cups"), false, "unknown weight units must not be silently treated as grams");

  // Retiring a failed draft starts a cold authenticated app. Its shell can
  // mount after the old 1.2-second delay without requiring credential login.
  const readinessPage = await browser.newPage();
  try {
    let readinessMode = "delayed-shell";
    let authenticated = false;
    await readinessPage.route("https://cronometer.com/**", (route) => route.fulfill({
      contentType: "text/html",
      body: authenticated
        ? "<body>Dashboard Diary Foods Custom Recipes CREATE RECIPE Sorted by</body>"
        : readinessMode === "delayed-shell"
          ? '<body>Loading...<script>setTimeout(()=>document.body.textContent="Dashboard Diary Foods Custom Recipes CREATE RECIPE Sorted by",2000)</script></body>'
          : readinessMode === "login"
            ? "<body>Welcome Back Email Password <button>Log In</button></body>"
            : "<body>Loading...</body>",
    }));
    const readinessProvider = new BrowserCronometerProvider({
      localChromium: true, writeEnabled: false, requireFoodConfirmation: true,
      navigationTimeoutMs: 3000, loginBackoffMs: 1000, operationTimeoutMs: 60000,
      browserRetryCount: 0, timeZone: "Asia/Jerusalem",
    });
    let credentialLoginCalls = 0;
    readinessProvider.login = async () => {
      credentialLoginCalls++;
      authenticated = true;
      await readinessPage.goto("https://cronometer.com/login/");
    };
    await readinessProvider.openApp(readinessPage, "#custom-recipes");
    assert.equal(credentialLoginCalls, 0, "a delayed authenticated shell must not trigger credential login after failed-draft cleanup");
    assert.equal(await readinessProvider.isLoggedIn(readinessPage), true);

    readinessMode = "login";
    await readinessPage.goto("about:blank");
    await readinessProvider.openApp(readinessPage, "#custom-recipes");
    assert.equal(credentialLoginCalls, 1, "an explicit login page must still use the existing login workflow");
    assert.equal(await readinessProvider.isLoggedIn(readinessPage), true);

    readinessMode = "unknown";
    authenticated = false;
    readinessProvider.config.navigationTimeoutMs = 500;
    await readinessPage.goto("about:blank");
    await assert.rejects(readinessProvider.openApp(readinessPage, "#custom-recipes"), /explicit login page.*No credentials were submitted/);
    assert.equal(credentialLoginCalls, 1, "an unfinished app must fail within its readiness budget without trying credentials");
  } finally {
    await readinessPage.close();
  }
} finally {
  await browser.close();
}
console.log("food editor DOM fixture tests passed");
