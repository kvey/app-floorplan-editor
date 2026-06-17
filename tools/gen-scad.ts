#!/usr/bin/env node
// Generates floorplan.scad from src/rooms.js (room-based CSG-shell walls).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ROOMS, DOORS, ROOF, STAIRS, FURNITURE } from "../src/rooms.ts";
import { roomsToScad } from "../src/scad.ts";
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "floorplan.scad");
writeFileSync(out, roomsToScad(ROOMS, DOORS, [], ROOF, STAIRS, FURNITURE));
console.log(`wrote ${out} (${ROOMS.length} rooms, ${DOORS.length} doors, ${STAIRS.length} stairs, ${FURNITURE.length} furniture)`);
