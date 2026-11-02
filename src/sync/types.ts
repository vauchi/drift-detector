/**
 * Plan-sync type definitions and trailer parsers
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface PlanTaskRef {
  slug: string;
  taskNumber?: number;
}

export interface ProblemRef {
  slug: string;
}

export interface SyncChangeset {
  planUpdates: PlanUpdate[];
  statusTransitions: StatusTransition[];
  fileMoves: FileMove[];
  reminders: string[];
}

export interface PlanUpdate {
  file: string;
  taskNumber: number;
  source: "trailer" | "inferred";
  confidence: "explicit" | "high" | "medium";
}

export interface StatusTransition {
  problem: string;
  problemDir: string;
  from: string;
  to: string;
  reason: string;
}

export interface FileMove {
  from: string;
  to: string;
}

export function parsePlanTaskTrailer(value: string): PlanTaskRef | null {
  if (!value || value.startsWith("#")) return null;
  const match = value.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:#(\d+))?$/);
  if (!match) return null;
  return {
    slug: match[1],
    taskNumber: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

export function parseProblemTrailer(value: string): ProblemRef | null {
  if (!value) return null;
  const match = value.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/);
  if (!match) return null;
  return { slug: match[1] };
}
