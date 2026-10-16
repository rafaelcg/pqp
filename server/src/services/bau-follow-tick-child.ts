/**
 * The second PROCESS of `bau-follow-two-process.test.ts`: runs the delivery
 * tick against the same database as its parent, at a shared instant, and exits.
 * Not imported by anything else.
 */
import { closePool } from "../db.js";
import { runBauFollowTick } from "./bau-follow-delivery.js";

const startAt = Number(process.env.BAU_TICK_START_AT ?? "0");
const rounds = Number(process.env.BAU_TICK_ROUNDS ?? "3");

while (Date.now() < startAt) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
let delivered = 0;
for (let i = 0; i < rounds; i += 1) {
  delivered += (await runBauFollowTick()).delivered;
}
console.log(`CHILD_DELIVERED ${delivered}`);
await closePool();
process.exit(0);
