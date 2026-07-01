import { openDatabase } from "../src/db/database.js";
import { getCurrentOperationalStock } from "../src/operational/stock-service.js";

const db = openDatabase("data/app.sqlite");
const stock = getCurrentOperationalStock(db);

let mappedUsable = 0;
let unmapped = 0;
let negativeGroups = 0;

for (const group of stock.groups) {
  if (group.currentQuantity < 0) negativeGroups++;
  if (group.mapeada) mappedUsable += group.currentQuantity;
  else unmapped += group.currentQuantity;
}

const totalUnits = stock.groups.reduce((acc, g) => acc + g.currentQuantity, 0);

console.log("total physical units:", totalUnits);
console.log("mapped usable units:", mappedUsable);
console.log("unmapped units:", unmapped);
console.log("number of stock groups:", stock.groups.length);
console.log("negative stock groups:", negativeGroups);
console.log("baseline type:", stock.base.type);
console.log("baseline cutoff:", stock.base.cutoffMovementId);
