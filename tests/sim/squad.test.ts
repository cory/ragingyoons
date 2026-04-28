/**
 * Squad-leader promotion. When the squad leader dies, squadTick should
 * promote the lowest-id surviving squad member and rewrite every alive
 * member's squadLeaderId. Without this the squad's followers would pull
 * toward a dead-rac id; cohesion would silently drop and the squad
 * would scatter.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { squadTick } from "../../src/sim/subsys/squad.js";
import { addRac, emptyState, makeBundle, makeUnit } from "../helpers/builders.js";

describe("squad leader promotion", () => {
  it("promotes the lowest-id surviving member when the leader dies", () => {
    const inf = makeUnit({ id: "inf", role: "infantry" });
    const content = makeBundle({ units: [inf] });
    const state = emptyState();

    // Build a squad of 3 racs. We pass a fixed squadId so they share
    // it, and squadLeaderId starts as the first rac's id (set on the
    // first add and copied to the others).
    const sid = state.nextSquadId++;
    const r0 = addRac(state, content, { unitId: "inf", owner: 0, x: 0, y: 0, squadId: sid });
    const r1 = addRac(state, content, { unitId: "inf", owner: 0, x: 1, y: 0, squadId: sid });
    const r2 = addRac(state, content, { unitId: "inf", owner: 0, x: 2, y: 0, squadId: sid });
    const leaderId = state.rac.id[r0];
    const followerAId = state.rac.id[r1];
    const followerBId = state.rac.id[r2];
    state.rac.squadLeaderId[r0] = leaderId;
    state.rac.squadLeaderId[r1] = leaderId;
    state.rac.squadLeaderId[r2] = leaderId;

    // Sanity: pre-promotion, all point at leader.
    assert.equal(state.rac.squadLeaderId[r1], leaderId);
    assert.equal(state.rac.squadLeaderId[r2], leaderId);

    // Kill the leader.
    state.rac.alive[r0] = 0;

    squadTick(state);

    // Lowest-id surviving member should now be the leader. r1 was
    // spawned next, so its rac id is below r2's.
    const expectedNewLeader = Math.min(followerAId, followerBId);
    assert.equal(state.rac.squadLeaderId[r1], expectedNewLeader);
    assert.equal(state.rac.squadLeaderId[r2], expectedNewLeader);
  });

  it("does nothing if the leader is still alive", () => {
    const inf = makeUnit({ id: "inf", role: "infantry" });
    const content = makeBundle({ units: [inf] });
    const state = emptyState();
    const sid = state.nextSquadId++;
    const r0 = addRac(state, content, { unitId: "inf", owner: 0, x: 0, y: 0, squadId: sid });
    const r1 = addRac(state, content, { unitId: "inf", owner: 0, x: 1, y: 0, squadId: sid });
    const leaderId = state.rac.id[r0];
    state.rac.squadLeaderId[r0] = leaderId;
    state.rac.squadLeaderId[r1] = leaderId;

    squadTick(state);

    assert.equal(state.rac.squadLeaderId[r0], leaderId);
    assert.equal(state.rac.squadLeaderId[r1], leaderId);
  });
});
