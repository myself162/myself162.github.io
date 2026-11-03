// 鍛造原型 v2 設定檔。所有數值與遺物定義都在這裡，改這裡不用動程式。
// 瀏覽器：掛在 window.FORGE_CONFIG；Node：module.exports。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FORGE_CONFIG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    version: 'v2 2026-11-03',

    // 回合：契約 contract 回合，之後進無盡。上貢不足累計 maxMisses 次，局結束。每回合供 supply 把武器。
    rounds: { contract: 21, maxMisses: 3, supply: 3 },

    // 武器價值 = base × perGrade^等級（四捨五入）。+5 ≈ 76，+10 ≈ 577，+15 ≈ 4379，+20 ≈ 33252。
    value: { base: 10, perGrade: 1.5 },

    // 配額：第 1 回合 base，之後每回合 ×growth；契約結束後每回合 ×endlessGrowth。
    quota: { base: 60, growth: 1.25, endlessGrowth: 1.2 },

    // 遺物商店：每回合開店 offers 個；重抽價 = max(rerollMin, 配額 × rerollFraction) × rerollGrowth^已付費重抽次數（每回合歸零）。
    // 遺物用劍幣買。劍幣來源：回合結束沒用完的武器（1 把 = 1 幣）、商店裡投入武器、鍛造時把沒敲過的武器投入商店。
    shop: { offers: 3, rerollFraction: 0.15, rerollMin: 10, rerollGrowth: 2.5 },

    // 商人賣武器：每回合 swordStock 把；價格 = max(minPrice, 配額 × fraction) × growth^本回合已買把數。用金幣買。
    // 金幣來源：每回合上貢的價值全額變成金幣（配額只是門檻）。
    merchant: { swordStock: 2, fraction: 0.4, minPrice: 20, growth: 1.5 },

    // 基礎籤（+0 時）。破壞籤另外由等級決定。
    baseTickets: { break: 0, damage: 3, hold: 5, success: 10, great: 2 },

    // 破壞籤 = 等級 × 這個數字。每升一級多幾張，畫在籤紙上，永不封頂。
    breakTicketsPerGrade: 1,

    // 各結果的等級變化。破壞 = 失去武器。
    gradeDelta: { great: 2, success: 1, hold: 0, damage: -1 },

    // 入神：每一次普通鎚擊充能 +1，滿 threshold 進入入神 strikes 鎚（破壞籤 = 0），
    // 結束後這把武器永久 +scar 張破壞籤（淬火疤）。疤隨武器消失。
    fever: { threshold: 10, strikes: 6, scar: 2 },

    // 遺物格與護盾位（標記 shield 的遺物同時只能持有這麼多個）。
    relicSlots: 5,
    shieldSlots: 1,

    // 開局免費三選一。
    starterOffer: true,

    // 遺物。effect 決定引擎走哪段邏輯，數字都可以改。price 是劍幣。
    // tickets：對籤數的加減。text / cost 只是顯示用。
    relics: [
      { id: 'sand', name: '磁砂', family: '成功', price: 1, effect: 'tickets',
        tickets: { success: 4, damage: 1 },
        text: '成功籤 +4', cost: '損傷籤 +1' },

      { id: 'dust', name: '金屑', family: '大成功', price: 1, effect: 'tickets',
        tickets: { great: 2, break: 1 },
        text: '大成功籤 +2', cost: '破壞籤 +1' },

      { id: 'hoop', name: '鐵箍', family: '防禦', price: 1, effect: 'tickets',
        tickets: { break: -2, success: -2 }, breakMin: 1,
        text: '破壞籤 −2（最低 1）', cost: '成功籤 −2' },

      { id: 'slow', name: '慢火', family: '維持', price: 1, effect: 'holdUpgrade',
        tickets: { hold: 3, success: -1 }, holdsNeeded: 3,
        text: '維持籤 +3；每累積 3 次維持，下一次成功升級為大成功', cost: '成功籤 −1' },

      { id: 'blade', name: '備用刃', family: '護盾', price: 2, shield: true, effect: 'shieldFirstBreak',
        gradeLoss: 3, scarAfter: 2,
        text: '每把武器第一次破壞改為「掉 3 級」', cost: '佔護盾位；觸發後這把武器破壞籤 +2' },

      { id: 'pact', name: '血契', family: '護盾', price: 2, shield: true, effect: 'shieldFromDamage',
        tickets: { damage: 2 }, damagesPerShield: 2, maxShield: 1,
        text: '每吃 2 次損傷，儲存一次「破壞改為損傷」，最多存 1', cost: '佔護盾位；損傷籤 +2' },

      { id: 'bellows', name: '風箱', family: '入神', price: 1, effect: 'feverMod',
        feverStrikes: 9, feverScar: 3,
        text: '入神鎚數 6 → 9', cost: '淬火疤 +2 → +3' },

      { id: 'ember', name: '餘燼', family: '入神', price: 1, effect: 'emberMod',
        startCharge: 3, feverThreshold: 12,
        text: '每把新武器起手充能 +3', cost: '入神門檻 10 → 12' },

      { id: 'gear', name: '齒輪', family: '累積', price: 2, effect: 'accumulateSuccess',
        tickets: { great: -1 }, perSuccess: 1,
        text: '每次成功或大成功，這把武器的成功籤 +1（上貢或破壞後歸零）', cost: '大成功籤 −1' },
    ],
  };
});
