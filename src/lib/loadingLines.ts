// ── Shared loading messages ──────────────────────────────────────────
// Each category is shuffled independently so no message repeats until
// the full deck has been shown.

const APP_LINES = [
  "Warming up the dashboard hamsters...",
  "Polishing your seat count...",
  "Negotiating with the loading bar...",
  "Counting pixels twice for accuracy...",
  "Folding business logic into tiny squares...",
  "Herding your settings into a straight line...",
  "Convincing the server it's morning...",
  "Tightening all the toggle switches...",
  "Double-checking your permissions with HR...",
  "Loading your preferences in alphabetical order...",
  "Giving the dashboard a pep talk...",
  "Untangling some very nested JSON...",
  "Placing your widgets with surgical precision...",
  "Waking up the notification bell...",
  "Feeding data to the charts...",
];

const INVENTORY_LINES = [
  "Counting bolts and pretending it's fun...",
  "Teaching the forklift to whisper...",
  "Dusting shelves for dramatic effect...",
  "Arguing with barcodes...",
  "Rehearsing the inventory roll call...",
  "Convincing the spreadsheet it's a database...",
  "Alphabetizing the chaos...",
  "Stacking rows like Tetris blocks...",
  "Double-counting just to be safe...",
  "Polishing every item name by hand...",
  "Shaking the inventory tree for loose items...",
  "Asking the warehouse for directions...",
  "Rounding up rogue quantities...",
  "Looking under every shelf...",
  "Measuring twice, loading once...",
  "Giving each item a participation trophy...",
  "Running a headcount on your stock...",
  "Fluffing the safety stock cushion...",
  "Calibrating the reorder sensors...",
  "Bribing the scanner to cooperate...",
  "Sorting by vibes, then by name...",
  "Making sure nothing expired while you blinked...",
  "Cross-referencing every serial number ever...",
  "Warming up the clipboard...",
  "Reminding items they have a purpose...",
];

const PROVISIONING_LINES = [
  "Building table legs for your table...",
  "Aligning columns with the moon phase...",
  "Applying premium spreadsheet vibes...",
  "Installing tiny seats for your rows...",
  "Preparing inventory storage...",
  "Waiting for rows to report in...",
  "Syncing quantity gears...",
  "Laying out the welcome mat for your data...",
  "Tuning the database strings...",
  "Rolling out a fresh tablecloth...",
  "Assigning each column a job title...",
  "Pouring the foundation for your inventory...",
  "Warming up the row factory...",
  "Teaching columns to stand up straight...",
  "Reserving premium shelf space...",
];

const USAGE_LINES = [
  "Gathering usage form parts...",
  "Counting what can be used...",
  "Lining up item bins...",
  "Preparing the tally sheet...",
  "Sharpening the usage pencil...",
  "Warming up the submit button...",
  "Sorting items by neediness...",
  "Checking the math one more time...",
  "Getting restock form ready...",
  "Counting shelves...",
  "Loading item list...",
  "Dusting off the clipboard...",
  "Queuing items for roll call...",
  "Polishing the quantity knobs...",
  "Consulting the restock oracle...",
];

// ── Shuffle-bag random (no repeats until all shown) ─────────────────

function createShuffleBag(source: string[]): () => string {
  let bag: string[] = [];
  return () => {
    if (bag.length === 0) {
      bag = [...source];
      // Fisher-Yates shuffle
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop()!;
  };
}

export const pickAppLine = createShuffleBag(APP_LINES);
export const pickInventoryLine = createShuffleBag(INVENTORY_LINES);
export const pickProvisioningLine = createShuffleBag(PROVISIONING_LINES);
export const pickUsageLine = createShuffleBag(USAGE_LINES);
