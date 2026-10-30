export class Progression {
  constructor(readonly step: number, readonly offset: number) {}

  static from(raw: string): Progression | null {
    const match = raw.replace(/\s+/g, "").toLowerCase().match(/^(?:(\d+)\*?)?n(?:([+-])(\d+))?$/);
    if (!match) return null;
    const step = Number(match[1] ?? 1);
    const offset = Number(match[3] ?? 0) * (match[2] === "-" ? -1 : 1);
    if (!Number.isSafeInteger(step) || step < 1 || step > 1000000 || !Number.isSafeInteger(offset) || Math.abs(offset) > 1000000) return null;
    return new Progression(step, offset);
  }

  picked(index: number): boolean {
    const page = index + 1;
    return Number.isSafeInteger(page) && page > 0 && page >= this.offset && (page - this.offset) % this.step === 0;
  }

  toString(): string {
    return `${this.step === 1 ? "" : this.step}n${this.offset === 0 ? "" : this.offset > 0 ? "+" + this.offset : this.offset}`;
  }
}

export class CherryPick {
  values: CherryPickRange[] = [];
  positive = false; // if values has positive picked, ignore exclude
  sieve: boolean[] = [];
  rule?: Progression;

  applyRule(raw: string): boolean {
    const rule = raw.trim() ? Progression.from(raw) : undefined;
    if (rule === null) return false;
    this.reset();
    this.rule = rule;
    return true;
  }

  preview(total: number, limit = 8): { count: number, pages: number[] } {
    let count = 0;
    const pages: number[] = [];
    for (let index = 0; index < total; index++) {
      if (!this.picked(index)) continue;
      count++;
      if (pages.length < limit) pages.push(index + 1);
    }
    return { count, pages };
  }

  reset() {
    this.values = [];
    this.positive = false;
    this.sieve = [];
    this.rule = undefined;
  }

  add(range: CherryPickRange): CherryPickRange[] | null {
    if (this.rule) {
      // Overrides remain ordered: the most recent matching operation wins.
      this.values = this.values.filter(value => value.id !== range.id);
      this.values.push(range);
      return this.values;
    }
    if (this.values.length === 0) {
      this.positive = range.positive;
      this.values.push(range);
      this.setSieve(range);
      return this.values;
    }

    const exists = this.values.find(v => v.id === range.id);
    if (exists) return null;
    const newR = range.range();
    const remIdSet: Set<string> = new Set();
    const addIdSet: Set<string> = new Set();
    const addList: CherryPickRange[] = [];
    let equalsOld = false;
    for (let i = 0; i < this.values.length; i++) {
      const old = this.values[i];
      const oldR = old.range();
      // new range overlaped by old range
      if (newR[0] >= oldR[0] && newR[1] <= oldR[1]) {
        if (range.positive !== this.positive) {
          remIdSet.add(old.id);
          if (oldR[0] < newR[0]) {
            addList.push(new CherryPickRange([oldR[0], newR[0] - 1], old.positive));
          }
          if (oldR[1] > newR[1]) {
            addList.push(new CherryPickRange([newR[1] + 1, oldR[1]], old.positive));
          }
          equalsOld = newR[0] === newR[1] && newR[0] === oldR[0] && newR[1] === oldR[1];
        }
        break;
      }

      if (newR[0] <= oldR[0] && newR[1] >= oldR[1]) {
        // new range contains old range
        remIdSet.add(old.id);
      } else if (newR[0] <= oldR[0] && newR[1] >= oldR[0] && newR[1] <= oldR[1]) {
        // new range right part intersects with old range
        old.reset([newR[1] + 1, oldR[1]]);
      } else if (newR[0] >= oldR[0] && newR[0] <= oldR[1] && newR[1] >= oldR[1]) {
        // new range left part intersects with old range
        old.reset([oldR[0], newR[0] - 1]);
      }
      if (range.positive === this.positive) {
        if (!addIdSet.has(range.id)) {
          addIdSet.add(range.id);
          addList.push(range);
        }
      }
    }

    if (remIdSet.size > 0) {
      this.values = this.values.filter(v => !remIdSet.has(v.id));
    }
    if (addList.length > 0) {
      this.values.push(...addList);
    }
    if (this.values.length === 0) {
      this.reset();
      if (equalsOld) {
        return this.values;
      }
      this.positive = range.positive;
      this.values.push(range);
    } else {
      this.concat();
    }
    this.setSieve(range);
    return this.values;
  }

  setSieve(range: CherryPickRange) {
    const newR = range.range();
    for (let i = newR[0] - 1; i < newR[1]; i++) {
      this.sieve[i] = range.positive === this.positive;
    }
  }

  concat() {
    if (this.values.length < 2) return;
    this.values.sort((v1, v2) => v1.range()[0] - v2.range()[0]);
    let i = 0, j = 1;
    const skip: number[] = [];
    while (i < this.values.length && j < this.values.length) {
      const r1 = this.values[i];
      const r2 = this.values[j];
      const r1v = r1.range();
      const r2v = r2.range();
      if (r1v[1] + 1 === r2v[0]) {
        r1.reset([r1v[0], r2v[1]]);
        skip.push(j);
        j++;
      } else {
        do {
          i++;
        } while (skip.includes(i));
        j = i + 1;
      }
    }
    this.values = this.values.filter((_, i) => !skip.includes(i));
  }

  remove(id: string) {
    const index = this.values.findIndex(v => v.id === id);
    if (index === -1) return;
    const range = this.values.splice(index, 1)[0];
    if (this.rule) return;
    const r = range.range();
    for (let i = r[0] - 1; i < r[1]; i++) {
      this.sieve[i] = false;
    }
    if (this.values.length === 0) {
      this.sieve = [];
      this.positive = false;
    }
  }

  picked(index: number): boolean {
    if (this.rule) {
      for (let i = this.values.length - 1; i >= 0; i--) {
        const range = this.values[i];
        if (index + 1 >= range.value[0] && index + 1 <= range.value[1]) return range.positive;
      }
      return this.rule.picked(index);
    }
    return Boolean(this.positive ? this.sieve[index] : !this.sieve[index]);
  }

}

export class CherryPickRange {
  value: number[];
  positive: boolean;
  id: string;
  constructor(value: number[], positive: boolean) {
    this.positive = positive;
    this.value = value.sort((a, b) => a - b);
    this.id = CherryPickRange.rangeToString(this.value, this.positive);
  }

  toString() {
    return CherryPickRange.rangeToString(this.value, this.positive);
  }

  reset(newRange: number[]) {
    this.value = newRange.sort((a, b) => a - b);
    this.id = CherryPickRange.rangeToString(this.value, this.positive);
  }

  range(): number[] {
    return this.value;
  }

  static rangeToString(value: number[], positive: boolean) {
    let str = "";
    if (value[0] === value[1]) {
      str = value[0].toString();
    } else {
      str = value.map(v => v.toString()).join("-");
    }
    return positive ? str : "!" + str;
  }

  static from(value: string): CherryPickRange | null {
    value = value?.trim();
    if (!value) return null;
    value = value.replace(/!+/, "!");
    const exclude = value.startsWith("!");
    if (/^!?\d+$/.test(value)) {
      const index = parseInt(value.replace("!", ""));
      if (!Number.isSafeInteger(index) || index < 1 || index > 1000000) return null;
      return new CherryPickRange([index, index], !exclude);
    }
    if (/^!?\d+-\d+$/.test(value)) {
      const splits = value.replace("!", "").split("-").map(v => parseInt(v));
      if (splits.some(index => !Number.isSafeInteger(index) || index < 1 || index > 1000000)) return null;
      return new CherryPickRange([splits[0], splits[1]], !exclude);
    }
    return null;
  }
}
