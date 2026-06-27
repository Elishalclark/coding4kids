// Run: node insert-lessons.js
// Inserts ~100 new lessons for worlds 17, 18, 19 into kidvibers D1 via wrangler

const { execSync } = require('child_process');

const WRANGLER = 'CLOUDFLARE_ACCOUNT_ID=3021aff7dc59bb05483ada6d03b99ad7 npx wrangler';
const DB = 'kidvibers';

function sql(cmd) {
  const escaped = cmd.replace(/'/g, "'\\''");
  try {
    execSync(`${WRANGLER} d1 execute ${DB} --remote --command '${escaped}'`, { stdio: 'pipe' });
  } catch (e) {
    console.error('SQL error:', e.message.slice(0, 200));
    console.error('CMD:', cmd.slice(0, 120));
  }
}

function getMaxPos() {
  const out = execSync(`${WRANGLER} d1 execute ${DB} --remote --command "SELECT COALESCE(MAX(position),151) p FROM lessons;"`, { encoding: 'utf8' });
  const m = out.match(/"p":\s*(\d+)/);
  return m ? parseInt(m[1]) : 151;
}

function lesson(id, unit, pos, emoji, title, blurb, level, xp, steps, quiz) {
  const stepsJson = JSON.stringify(steps).replace(/'/g, "''");
  const quizJson  = JSON.stringify(quiz).replace(/'/g, "''");
  return `INSERT OR IGNORE INTO lessons (id,unit,position,emoji,title,blurb,level,xp,published,steps,quiz) VALUES ('${id}',${unit},${pos},'${emoji}','${title.replace(/'/g,"''")}','${blurb.replace(/'/g,"''")}','${level}',${xp},1,'${stepsJson}','${quizJson}');`;
}

// ── helpers ──────────────────────────────────────────────────────
const s = (h, p, code) => code ? {h,p,code} : {h,p};
const q = (q, opts, answer) => ({q, opts, answer});

let basePos;

// ════════════════════════════════════════════════
// WORLD 17 — Creative Studio (unit 17) — 34 lessons
// ════════════════════════════════════════════════
const w17 = [
  // Colors & Art
  ['l153','🎨','Colors with Code','Learn to describe colors using RGB numbers.','Ages 8+',45,
   [s('What is RGB?','Computers make colors using three numbers: Red, Green, Blue. Each is 0–255.'),
    s('Try it','This prints color info:','print("Red:", 255, "Green:", 0, "Blue:", 0)\nprint("That makes pure red!")'),
    s('Mix it','255,255,0 is yellow. 0,0,255 is blue. 0,255,0 is green.')],
   q('What does RGB stand for?',['Random Game Bytes','Red Green Blue','Rows Grids Boxes'],1)],

  ['l154','🖌️','Painting with Variables','Store colors in variables and mix them.','Ages 8+',45,
   [s('Color variables','Store your favorite colors:','red = (255, 0, 0)\nblue = (0, 0, 255)\nprint("My colors:", red, blue)'),
    s('Mixing math','Add RGB values together and divide by 2 to mix colors.'),
    s('Try it','r = (255+0)//2\ng = (0+0)//2\nb = (0+255)//2\nprint("Purple:", r, g, b)')],
   q('How do you store color red in Python?',['red = "255,0,0"','red = (255, 0, 0)','red = [r,g,b]'],1)],

  ['l155','⭐','Pattern Power','Use loops to print repeating patterns.','Ages 8+',50,
   [s('Loop art','A loop can make a pattern:','for i in range(5):\n    print("⭐" * i)'),
    s('Try it','Change the emoji and range to make your own pattern!'),
    s('Rows and columns','for row in range(3):\n    for col in range(3):\n        print("🟦", end="")\n    print()')],
   q('What does end="" do in print?',['Stops the program','Keeps the cursor on the same line','Adds a space'],1)],

  ['l156','🌈','Rainbow Loop','Print a rainbow using a list of colors.','Ages 8+',50,
   [s('Color list','rainbow = ["red","orange","yellow","green","blue","purple"]\nfor color in rainbow:\n    print(color)'),
    s('Add emojis','emojis = ["🔴","🟠","🟡","🟢","🔵","🟣"]\nfor e in emojis:\n    print(e, end=" ")'),
    s('Pro tip','end=" " prints items on one line with spaces between them.')],
   q('How do you loop through a list?',['for item in my_list:','loop item in list:','foreach item:'],0)],

  ['l157','🖼️','ASCII Art','Create pictures using text characters.','Ages 8+',55,
   [s('What is ASCII art?','ASCII art uses keyboard characters to make pictures.'),
    s('Simple house','print("  /\\\\")\nprint(" /  \\\\")\nprint("/____\\\\")\nprint("|    |")\nprint("|____|")'),
    s('Your turn','Try making a star or a tree using print statements!')],
   q('What is ASCII art?',['Pictures made with pixels','Pictures made with keyboard characters','A type of painting app'],1)],

  ['l158','🎭','Emoji Stories','Use emojis and variables to tell a story.','Ages 8+',45,
   [s('Story variables','hero = "🦸"\nvillain = "🐲"\nprint(hero, "faces the", villain, "!")'),
    s('Add a plot','victory = "⚔️"\nprint(hero, victory, villain)\nprint("The hero wins! 🏆")'),
    s('Your turn','Create your own emoji story with at least 3 characters.')],
   q('How do you print two variables with text between them?',['print(a + b)','print(a, "text", b)','print(a & "text" & b)'],1)],

  ['l159','🎵','Music Notes as Numbers','Learn how music and code connect.','Ages 8+',50,
   [s('Sound is math','Every musical note has a frequency (a number). A4 = 440 Hz.'),
    s('Scale in code','notes = {"C":262,"D":294,"E":330,"F":349,"G":392,"A":440,"B":494}\nfor note, freq in notes.items():\n    print(note, "=", freq, "Hz")'),
    s('Fun fact','Higher numbers = higher pitch. Doubling the frequency goes up one octave.')],
   q('What does frequency measure in music?',['Volume','Pitch (how high or low)','Length of a note'],1)],

  ['l160','🥁','Beat Patterns','Code a drum machine with lists.','Ages 8+',55,
   [s('Beat list','A 1 means hit, 0 means rest:','beat = [1,0,1,0,1,1,0,1]'),
    s('Play the beat','for b in beat:\n    if b == 1:\n        print("BOOM!", end=" ")\n    else:\n        print("....", end=" ")'),
    s('Your turn','Try changing the pattern in the beat list and run it again.')],
   q('In the beat list, what does 0 represent?',['A drum hit','A rest (silence)','The tempo'],1)],

  ['l161','🎼','Make a Song','Combine notes and beats into a simple song.','Ages 9+',60,
   [s('Song structure','A song has notes AND timing. Let\'s combine them:'),
    s('Code it','song = ["C","C","G","G","A","A","G"]\nfor note in song:\n    print("Playing:", note)'),
    s('That\'s Twinkle Twinkle!','You just coded the first line of Twinkle Twinkle Little Star!')],
   q('What is a sequence of notes called?',['A loop','A melody','A variable'],1)],

  ['l162','🔀','Shuffle a Playlist','Use random to shuffle a list.','Ages 9+',55,
   [s('Import random','import random\nplaylist = ["Song A","Song B","Song C","Song D"]\nrandom.shuffle(playlist)\nprint(playlist)'),
    s('Pick one','print("Now playing:", random.choice(playlist))'),
    s('Every run is different','shuffle() reorders the list differently each time you run it.')],
   q('What does random.shuffle() do?',['Picks one random item','Reorders the whole list randomly','Deletes random items'],1)],

  ['l163','🎨','Color Mixer App','Build an app that mixes colors.','Ages 9+',60,
   [s('Get input','r = int(input("Red (0-255): "))\ng = int(input("Green (0-255): "))\nb = int(input("Blue (0-255): "))'),
    s('Show result','print(f"Your color is RGB({r}, {g}, {b})")'),
    s('Classify it','if r > 200 and g < 50 and b < 50:\n    print("That\'s a red color!")\nelif g > 200:\n    print("That\'s a green color!")')],
   q('What does int() do to input?',['Makes it lowercase','Converts text to a whole number','Checks if it\'s a number'],1)],

  ['l164','✨','Sparkle Generator','Print random sparkle patterns.','Ages 9+',55,
   [s('Import random','import random\nsparkles = ["✨","⭐","💫","🌟","⚡"]'),
    s('Random art','for i in range(10):\n    print(random.choice(sparkles), end=" ")\nprint()'),
    s('Grid version','for row in range(5):\n    for col in range(8):\n        print(random.choice(sparkles), end="")\n    print()')],
   q('What does random.choice() do?',['Picks a random item from a list','Shuffles the list','Picks the first item'],0)],

  ['l165','🌀','Spiral Thinking','Understand how spiral patterns work in code.','Ages 9+',60,
   [s('Spiral = growing loop','A spiral gets bigger each step. In code: each ring adds more.'),
    s('Code a spiral','for size in range(1, 6):\n    print("*" * size)'),
    s('Pyramid version','n = 5\nfor i in range(1, n+1):\n    print(" " * (n-i) + "*" * (2*i-1))')],
   q('What pattern does "print(*" * size)" for size 1 to 5 make?',['A triangle','A square','A circle'],0)],

  ['l166','🖼️','Make an Art Gallery','Store artworks in a dictionary.','Ages 9+',60,
   [s('Gallery dict','gallery = {\n    "Starry Night": "Van Gogh, 1889",\n    "Mona Lisa": "da Vinci, 1503",\n    "Scream": "Munch, 1893"\n}'),
    s('Display it','for title, info in gallery.items():\n    print(f"{title} by {info}")'),
    s('Add to it','gallery["My Code Art"] = "Me, 2026"\nprint("Gallery now has", len(gallery), "pieces")')],
   q('What method shows all key-value pairs in a dictionary?',['gallery.pairs()','gallery.items()','gallery.all()'],1)],

  ['l167','🌟','Score & Stars','Give ratings using stars.','Ages 9+',55,
   [s('Star rating','def star_rating(score):\n    stars = "⭐" * score\n    return stars'),
    s('Use it','print(star_rating(3))\nprint(star_rating(5))'),
    s('Add limits','def star_rating(score):\n    score = max(1, min(5, score))\n    return "⭐" * score')],
   q('What does max(1, min(5, score)) do?',['Doubles the score','Clamps score between 1 and 5','Adds stars'],1)],

  ['l168','🎪','Story Generator','Build a random story maker.','Ages 9+',60,
   [s('Word lists','import random\nheroes = ["a knight","a coder","a wizard"]\nplaces = ["in space","at school","in a forest"]\nactions = ["found treasure","defeated a bug","learned Python"]'),
    s('Build story','hero = random.choice(heroes)\nplace = random.choice(places)\naction = random.choice(actions)\nprint(f"Once upon a time, {hero} {place} {action}!")'),
    s('Your turn','Add more words to make the stories even wilder!')],
   q('How do you join variables into a sentence?',['variable + variable','f"text {variable} text"','print(variable, variable)'],1)],

  ['l169','🎨','Color Names','Map color names to their RGB values.','Ages 9+',55,
   [s('Color dictionary','colors = {\n    "red": (255,0,0),\n    "blue": (0,0,255),\n    "yellow": (255,255,0),\n    "white": (255,255,255)\n}'),
    s('Look up a color','name = "blue"\nprint(f"{name} = {colors[name]}")'),
    s('Add new colors','colors["pink"] = (255,105,180)\nprint("New color added:", colors["pink"])')],
   q('How do you look up a value in a dictionary?',['dictionary[key]','dictionary.get_value(key)','dictionary->key'],0)],

  ['l170','🔁','Animation Loop','Simulate animation with a loop.','Ages 9+',60,
   [s('What is animation?','Animation is many images shown quickly. In text: print different frames in a loop.'),
    s('Simple animation','import time\nframes = ["-", "\\\\", "|", "/"]\nfor i in range(12):\n    print("\\r" + frames[i % 4], end="", flush=True)\n    time.sleep(0.2)'),
    s('Key idea','i % 4 cycles through 0,1,2,3 forever — perfect for looping frames!')],
   q('What does i % 4 do when i=5?',['Returns 5','Returns 1','Returns 4'],1)],

  ['l171','🎯','Target Practice','Build a number guessing art game.','Ages 10+',65,
   [s('Setup','import random\ntarget = random.randint(1, 10)\nguess = int(input("Guess 1-10: "))'),
    s('Check it','if guess == target:\n    print("🎯 Bullseye!")\nelif abs(guess - target) <= 2:\n    print("🔥 So close!")\nelse:\n    print("❄️ Cold!")'),
    s('abs()','abs() gives the absolute (positive) difference between two numbers.')],
   q('What does abs(-3) return?',['3','- 3','0'],0)],

  ['l172','🌈','Gradient Maker','Print a color gradient using numbers.','Ages 10+',65,
   [s('Gradient = slow change','A gradient goes from one color to another gradually.'),
    s('Code it','steps = 10\nfor i in range(steps + 1):\n    r = int(255 * i / steps)\n    g = 0\n    b = int(255 * (1 - i/steps))\n    print(f"Step {i}: RGB({r},{g},{b})")'),
    s('What happened?','Red goes from 0→255 while Blue goes from 255→0. That\'s a red-to-blue gradient!')],
   q('In a gradient, colors change...',['Suddenly','Gradually and smoothly','Randomly'],1)],

  ['l173','🎭','Mood Machine','Match moods to colors and emojis.','Ages 10+',60,
   [s('Mood dict','moods = {\n    "happy": ("yellow", "😊"),\n    "sad": ("blue", "😢"),\n    "excited": ("red", "🤩"),\n    "calm": ("green", "😌")\n}'),
    s('User input','mood = input("How do you feel? ").lower()\nif mood in moods:\n    color, emoji = moods[mood]\n    print(f"Your mood color: {color} {emoji}")'),
    s('Unpacking','color, emoji = moods[mood] — this unpacks the tuple into two variables at once.')],
   q('What does .lower() do to a string?',['Makes it uppercase','Converts to lowercase','Removes spaces'],1)],

  ['l174','🎸','Chord Patterns','Use math to find musical chords.','Ages 10+',65,
   [s('What is a chord?','A chord is 3+ notes played at once. Major chords go: root, +4, +3 semitones.'),
    s('Notes list','notes = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]\nroot = 0\nprint("C major:", notes[root], notes[root+4], notes[root+7])'),
    s('Any root','root = 7  # G\nprint("G major:", notes[root % 12], notes[(root+4)%12], notes[(root+7)%12])')],
   q('What does % 12 do in music code?',['Divides by 12','Wraps notes back to the start of the scale','Multiplies by 12'],1)],

  ['l175','🌟','Pixel Counter','Count pixels in a simple grid.','Ages 10+',65,
   [s('Grid setup','grid = [\n    [1,0,1],\n    [0,1,0],\n    [1,0,1]\n]'),
    s('Count pixels','count = 0\nfor row in grid:\n    for pixel in row:\n        count += pixel\nprint("Lit pixels:", count)'),
    s('That\'s a checkerboard!','The grid above makes an X pattern. 5 pixels are lit (value=1).')],
   q('How do you loop through a 2D grid?',['One for loop','for row: for item in row:','while grid:'],1)],

  ['l176','🎬','Scene Builder','Build a text scene with characters.','Ages 10+',65,
   [s('Scene setup','sky = "☁️ ☁️ ☁️  ☁️"\nground = "🌿🌿🌿🌿🌿🌿"\ncharacter = "     🧍"\nprint(sky)\nprint()\nprint(character)\nprint(ground)'),
    s('Add movement','import time\nfor pos in range(6):\n    print("\\r" + " " * pos + "🏃", end="", flush=True)\n    time.sleep(0.3)'),
    s('Animation trick','\\r moves the cursor back to the start of the line, so we overwrite it.')],
   q('What does \\r do in a print statement?',['Adds a new line','Returns cursor to start of current line','Clears the screen'],1)],

  ['l177','🎨','Palette Generator','Generate random color palettes.','Ages 10+',65,
   [s('Random colors','import random\ndef random_color():\n    r = random.randint(0, 255)\n    g = random.randint(0, 255)\n    b = random.randint(0, 255)\n    return (r, g, b)'),
    s('Make a palette','palette = [random_color() for _ in range(5)]\nfor i, color in enumerate(palette):\n    print(f"Color {i+1}: RGB{color}")'),
    s('List comprehension','[random_color() for _ in range(5)] builds a list by running random_color() 5 times.')],
   q('What is a list comprehension?',['A description of a list','A short way to build a list with a loop','A way to sort a list'],1)],

  ['l178','⭐','Starfield','Print a random starfield.','Ages 10+',65,
   [s('Starfield','import random\nfor row in range(8):\n    line = ""\n    for col in range(20):\n        if random.random() < 0.15:\n            line += "⭐"\n        else:\n            line += "  "\n    print(line)'),
    s('random.random()','Returns a float between 0.0 and 1.0. < 0.15 means 15% chance of a star.'),
    s('Try it','Change 0.15 to 0.5 for a denser starfield.')],
   q('What does random.random() return?',['A random integer','A float between 0.0 and 1.0','A random string'],1)],

  ['l179','🎠','Carousel of Choices','Loop a menu that keeps coming back.','Ages 10+',70,
   [s('Infinite menu','while True:\n    print("\\n1. Draw art\\n2. Play music\\n3. Exit")\n    choice = input("Pick: ")\n    if choice == "3":\n        print("Bye! 👋")\n        break\n    elif choice == "1":\n        print("🎨 Drawing...")\n    elif choice == "2":\n        print("🎵 Playing...")'),
    s('break','break exits the while True loop immediately.'),
    s('while True','while True runs forever until a break is hit.')],
   q('What exits a while True loop?',['return','stop','break'],2)],

  ['l180','🌟','Creative Project - Art Generator','Build a full art generator app.','Ages 10+',80,
   [s('Plan it','Your app will: ask for a style, generate matching art, and let the user save it.'),
    s('Build it','import random\nstyle = input("Pick a style (stars/blocks/lines): ").lower()\nif style == "stars":\n    for _ in range(5):\n        print("⭐" * random.randint(1,8))\nelif style == "blocks":\n    for _ in range(4):\n        print("🟦" * random.randint(2,6))\nelse:\n    for _ in range(6):\n        print("-" * random.randint(5,15))'),
    s('Great work!','You built a full creative app. This is real programming!')],
   q('What does random.randint(1,8) return?',['Always 1','A random whole number between 1 and 8','A float between 1 and 8'],1)],

  ['l181','🎵','Creative Project - Playlist Maker','Build a playlist manager.','Ages 10+',80,
   [s('Start','playlist = []\nwhile True:\n    print("\\n1.Add song  2.Show  3.Shuffle  4.Quit")'),
    s('Add and show','    choice = input("Choice: ")\n    if choice == "1":\n        song = input("Song name: ")\n        playlist.append(song)\n    elif choice == "2":\n        print("Playlist:", playlist)'),
    s('Shuffle and quit','    elif choice == "3":\n        import random\n        random.shuffle(playlist)\n        print("Shuffled:", playlist)\n    elif choice == "4":\n        break')],
   q('What does list.append(item) do?',['Removes the item','Adds the item to the end of the list','Sorts the list'],1)],

  ['l182','🖼️','Creative Project - Mood Journal','Build a mood tracking journal.','Ages 10+',80,
   [s('Journal app','journal = []\nwhile True:\n    print("\\n1.Add entry  2.Show journal  3.Quit")'),
    s('Add entries','    c = input("Choice: ")\n    if c == "1":\n        mood = input("How do you feel? ")\n        note = input("Note: ")\n        journal.append({"mood": mood, "note": note})\n    elif c == "2":\n        for i, e in enumerate(journal):\n            print(f"{i+1}. {e[\'mood\']}: {e[\'note\']}")'),
    s('Your turn','Try adding a date to each entry using a dictionary.')],
   q('How do you store multiple pieces of data together?',['A variable','A dictionary or list','A print statement'],1)],

  ['l183','🌈','Creative Bonus - ASCII Banner','Print your name as a big ASCII banner.','Ages 8+',60,
   [s('Banner idea','Make each letter big using print statements:'),
    s('Letter K example','print("| /")\nprint("|< ")\nprint("| \\\\")\nprint()\nprint("Your name in code!")\n# Try making your own initials!'),
    s('Pro tip','You can also use the "art" pattern: repeat characters to build shapes.')],
   q('ASCII art uses which of these?',['Images and photos','Keyboard characters to draw pictures','Video files'],1)],

  ['l184','🎭','Creative Bonus - Joke Generator','Build a random joke machine.','Ages 8+',55,
   [s('Joke setup','import random\nsetups = ["Why did the coder quit?","What do you call a coding dog?","Why do programmers prefer dark mode?"]\npunchlines = ["Because they lost their job!","A labrador-ator!","Because light attracts bugs!"]'),
    s('Tell a joke','idx = random.randint(0, 2)\nprint(setups[idx])\ninput("...press Enter for the punchline...")\nprint(punchlines[idx])'),
    s('Your turn','Add 3 more jokes of your own to the lists!')],
   q('How do you get the same index from two lists?',['Use the same variable for both','Use different variables','Use .match()'],0)],
];

// ════════════════════════════════════════════════
// WORLD 18 — App Builder Workshop (unit 18) — 33 lessons
// ════════════════════════════════════════════════
const w18 = [
  ['l187','📱','What is an App?','Learn what apps are made of.','Ages 9+',45,
   [s('Apps are programs','Every app — games, calculators, maps — is just code that runs.'),
    s('Parts of an app','1. Input (user does something)\n2. Processing (code figures it out)\n3. Output (shows the result)'),
    s('Simplest app','name = input("Your name: ")\nprint(f"Hello, {name}! Welcome to your first app!")')],
   q('What are the 3 parts of an app?',['Code, Test, Launch','Input, Processing, Output','Variables, Loops, Functions'],1)],

  ['l188','✅','Input Validation','Check that users type the right thing.','Ages 9+',50,
   [s('Why validate?','Users might type letters when you need a number. Always check!'),
    s('Validate age','age_str = input("Your age: ")\nif age_str.isdigit():\n    age = int(age_str)\n    print(f"You are {age} years old.")\nelse:\n    print("Please enter a number!")'),
    s('.isdigit()','Returns True if the string contains only digits.')],
   q('What does "5".isdigit() return?',['False','True','"5"'],1)],

  ['l189','🔄','While Loop Validation','Keep asking until valid input.','Ages 9+',55,
   [s('Loop until valid','while True:\n    age_str = input("Enter your age: ")\n    if age_str.isdigit():\n        age = int(age_str)\n        break\n    print("Numbers only please!")'),
    s('Explain it','The loop keeps going until the user types a number. break exits when valid.'),
    s('Try it','Add a check that age must be between 1 and 120.')],
   q('Why use while True with input validation?',['To run forever','To keep asking until the user gives a valid answer','To speed up the program'],1)],

  ['l190','🔑','Login System','Build a simple username/password check.','Ages 9+',60,
   [s('Stored credentials','USERNAME = "coder"\nPASSWORD = "python123"'),
    s('Login check','user = input("Username: ")\npwd = input("Password: ")\nif user == USERNAME and pwd == PASSWORD:\n    print("✅ Welcome back!")\nelse:\n    print("❌ Wrong username or password.")'),
    s('Real apps hash passwords','In real apps, passwords are scrambled (hashed). We never store them as plain text.')],
   q('What does "and" do in an if statement?',['Both conditions must be True','Either condition must be True','Only the first condition matters'],0)],

  ['l191','🔐','3 Attempts Login','Allow only 3 login tries.','Ages 9+',60,
   [s('Count attempts','USERNAME = "coder"\nPASSWORD = "python123"\nfor attempt in range(3):\n    user = input("Username: ")\n    pwd = input("Password: ")\n    if user == USERNAME and pwd == PASSWORD:\n        print("✅ Logged in!")\n        break\n    print(f"❌ Wrong. {2-attempt} tries left.")\nelse:\n    print("🔒 Account locked!")'),
    s('for...else','The else on a for loop runs only if the loop finishes WITHOUT hitting a break.'),
    s('Security!','Limiting login attempts stops brute-force attacks.')],
   q('When does "for...else" run its else block?',['Always','When the loop finishes without a break','When an error occurs'],1)],

  ['l192','🧮','Calculator App','Build a full four-function calculator.','Ages 9+',65,
   [s('Get numbers','a = float(input("First number: "))\nb = float(input("Second number: "))'),
    s('Pick operation','op = input("Operation (+,-,*,/): ")\nif op == "+":\n    print(a + b)\nelif op == "-":\n    print(a - b)\nelif op == "*":\n    print(a * b)\nelif op == "/" and b != 0:\n    print(a / b)\nelse:\n    print("Invalid!")'),
    s('float()','float() converts input to a decimal number, so 3.5 works too.')],
   q('Why check "b != 0" before dividing?',['To make the code longer','Division by zero causes an error','To convert to float'],1)],

  ['l193','📝','To-Do List App','Build a full to-do list manager.','Ages 9+',65,
   [s('Start','tasks = []\nwhile True:\n    print("\\n1.Add  2.Show  3.Done  4.Quit")'),
    s('Add and show','    c = input("Choice: ")\n    if c == "1":\n        tasks.append(input("Task: "))\n    elif c == "2":\n        for i,t in enumerate(tasks):\n            print(f"{i+1}. {t}")'),
    s('Remove done','    elif c == "3":\n        idx = int(input("Task # done: ")) - 1\n        tasks.pop(idx)\n    elif c == "4":\n        break')],
   q('What does list.pop(i) do?',['Adds item at position i','Removes and returns item at position i','Counts items'],1)],

  ['l194','📒','Notes App','Save and load personal notes.','Ages 9+',65,
   [s('Notes dictionary','notes = {}\nwhile True:\n    print("\\n1.New note  2.Read  3.List  4.Quit")'),
    s('Add and read','    c = input(": ")\n    if c == "1":\n        title = input("Title: ")\n        body = input("Note: ")\n        notes[title] = body\n    elif c == "2":\n        t = input("Title to read: ")\n        print(notes.get(t, "Not found"))'),
    s('List notes','    elif c == "3":\n        print("Notes:", list(notes.keys()))\n    elif c == "4":\n        break')],
   q('What does dict.get(key, default) do?',['Always raises an error if missing','Returns default if key not found','Deletes the key'],1)],

  ['l195','🃏','Flashcard App','Build a study tool with flashcards.','Ages 9+',65,
   [s('Card data','cards = {\n    "What is a variable?": "A named container for data",\n    "What is a loop?": "Code that repeats",\n    "What is a function?": "Reusable block of code"\n}'),
    s('Quiz mode','import random\nitems = list(cards.items())\nrandom.shuffle(items)\nfor question, answer in items:\n    input(question + " -> ")\n    print("Answer:", answer)'),
    s('Add your own','Add more cards to study any subject!')],
   q('What does list(cards.items()) do?',['Deletes the dictionary','Converts dict key-value pairs into a list','Sorts the dictionary'],1)],

  ['l196','❓','Quiz App','Build a full quiz game.','Ages 9+',70,
   [s('Quiz data','quiz = [\n    {"q":"What is 2+2?","opts":["3","4","5"],"ans":1},\n    {"q":"Python creator?","opts":["Gates","Guido","Torvalds"],"ans":1}\n]'),
    s('Run quiz','score = 0\nfor q in quiz:\n    print(q["q"])\n    for i,o in enumerate(q["opts"]):\n        print(f"{i+1}. {o}")\n    ans = int(input("Answer: ")) - 1\n    if ans == q["ans"]:\n        print("✅ Correct!")\n        score += 1\n    else:\n        print("❌ Wrong")'),
    s('Final score','print(f"Score: {score}/{len(quiz)}")')],
   q('How do you access a dictionary value?',['dict(key)','dict[key]','dict->key'],1)],

  ['l197','⏱️','Countdown Timer','Build a countdown timer app.','Ages 9+',65,
   [s('Import time','import time\nseconds = int(input("Count down from: "))'),
    s('Countdown','for i in range(seconds, 0, -1):\n    print(f"\\r⏱️ {i} seconds", end="", flush=True)\n    time.sleep(1)\nprint("\\n🔔 Time\'s up!")'),
    s('range with step','range(10, 0, -1) counts from 10 down to 1. The -1 is the step.')],
   q('What does range(5, 0, -1) produce?',['5,4,3,2,1','0,1,2,3,4,5','5,4,3,2,1,0'],0)],

  ['l198','💰','Tip Calculator','Calculate tips and split bills.','Ages 9+',60,
   [s('Get bill info','bill = float(input("Bill amount ($): "))\ntip_pct = float(input("Tip %: "))\npeople = int(input("Number of people: "))'),
    s('Calculate','tip = bill * (tip_pct / 100)\ntotal = bill + tip\nper_person = total / people\nprint(f"Tip: ${tip:.2f}")\nprint(f"Total: ${total:.2f}")\nprint(f"Per person: ${per_person:.2f}")'),
    s(':.2f','The :.2f format code rounds to 2 decimal places — perfect for money.')],
   q('What does :.2f do in an f-string?',['Adds 2 to the number','Formats to 2 decimal places','Divides by 2'],1)],

  ['l199','🔄','Unit Converter','Convert between different units.','Ages 9+',60,
   [s('Conversion formulas','def celsius_to_f(c):\n    return c * 9/5 + 32\ndef km_to_miles(km):\n    return km * 0.621371'),
    s('Menu','while True:\n    print("1.Temp  2.Distance  3.Quit")\n    c = input(": ")\n    if c == "1":\n        temp = float(input("Celsius: "))\n        print(f"{temp}°C = {celsius_to_f(temp):.1f}°F")\n    elif c == "2":\n        km = float(input("Km: "))\n        print(f"{km}km = {km_to_miles(km):.2f} miles")\n    elif c == "3":\n        break'),
    s('Functions','Each conversion is its own function. Clean and reusable!')],
   q('What is the formula for Celsius to Fahrenheit?',['C * 2 + 30','C * 9/5 + 32','C + 273'],1)],

  ['l200','🔐','Password Generator','Generate strong random passwords.','Ages 9+',65,
   [s('Import string','import random, string\nlength = int(input("Password length: "))'),
    s('Generate','chars = string.ascii_letters + string.digits + "!@#$"\npassword = "".join(random.choice(chars) for _ in range(length))\nprint("Your password:", password)'),
    s('string.ascii_letters','Contains all letters a-z and A-Z. string.digits is 0-9.')],
   q('What does "".join(list) do?',['Splits a string','Joins list items into a single string','Counts characters'],1)],

  ['l201','🎲','Number Guessing Game','Build a complete number guessing game.','Ages 9+',70,
   [s('Setup','import random\nsecret = random.randint(1, 100)\nattempts = 0'),
    s('Game loop','while True:\n    guess = int(input("Guess (1-100): "))\n    attempts += 1\n    if guess < secret:\n        print("📈 Too low!")\n    elif guess > secret:\n        print("📉 Too high!")\n    else:\n        print(f"🎉 Got it in {attempts} tries!")\n        break'),
    s('Binary search','Going to the middle each time finds the answer in at most 7 guesses!')],
   q('What is the best strategy to guess a number 1-100?',['Always guess 1','Guess the middle each time','Guess randomly'],1)],

  ['l202','🔤','Word Scramble Game','Scramble words for a spelling game.','Ages 9+',65,
   [s('Word list','import random\nwords = ["python","coding","computer","function","variable"]\nword = random.choice(words)\nscrambled = list(word)\nrandom.shuffle(scrambled)\nscrambled = "".join(scrambled)'),
    s('Game','print(f"Unscramble: {scrambled}")\nguess = input("Your answer: ").lower()\nif guess == word:\n    print("✅ Correct!")\nelse:\n    print(f"❌ It was: {word}")'),
    s('list(word)','Converts a string into a list of characters so shuffle() can reorder them.')],
   q('Why convert string to list before shuffling?',['Strings are faster','shuffle() works on lists, not strings directly','Lists are shorter'],1)],

  ['l203','🎪','Hangman Game','Build the classic hangman game.','Ages 10+',75,
   [s('Setup','import random\nwords = ["python","keyboard","monitor","function"]\nword = random.choice(words)\nguessed = set()\nattempts = 6'),
    s('Game loop','while attempts > 0:\n    display = [c if c in guessed else "_" for c in word]\n    print(" ".join(display))\n    if "_" not in display:\n        print("🎉 You won!")\n        break\n    letter = input("Guess a letter: ").lower()\n    if letter in word:\n        guessed.add(letter)\n    else:\n        attempts -= 1\n        print(f"❌ Wrong! {attempts} left")'),
    s('List comprehension','[c if c in guessed else "_" for c in word] — shows known letters, hides the rest.')],
   q('What is a set used for in Hangman?',['Storing the word','Storing guessed letters without duplicates','Counting attempts'],1)],

  ['l204','🎯','Mad Libs Generator','Build a funny story filler.','Ages 9+',60,
   [s('Collect words','adj = input("Adjective: ")\nnoun = input("Noun: ")\nverb = input("Verb: ")\nplace = input("Place: ")'),
    s('Fill the story','story = f"One {adj} day, a {noun} decided to {verb} all the way to {place}."\nprint("\\n📖 Your story:")\nprint(story)'),
    s('More words','The more blanks you add, the funnier the story gets!')],
   q('What is an f-string used for?',['Math calculations','Putting variables inside strings','Making lists'],1)],

  ['l205','🌍','Text Adventure Game','Build a choose-your-own-adventure.','Ages 10+',75,
   [s('Scene 1','print("You wake up in a forest. 🌲")\nchoice = input("Go left or right? ").lower()'),
    s('Branch','if choice == "left":\n    print("You find a treasure chest! 💰")\n    choice2 = input("Open or leave? ").lower()\n    if choice2 == "open":\n        print("🎉 You found gold!")\n    else:\n        print("You walked away. Safe but poor.")\nelif choice == "right":\n    print("A dragon! 🐲 Run!")\nelse:\n    print("You stood still and got lost.")'),
    s('Your turn','Add more scenes and choices!')],
   q('How do you create branching story choices?',['With loops','With nested if/elif/else statements','With functions only'],1)],

  ['l206','📊','Leaderboard App','Track and sort high scores.','Ages 10+',70,
   [s('Score data','scores = {}\nwhile True:\n    print("1.Add score  2.Show board  3.Quit")\n    c = input(": ")'),
    s('Add scores','    if c == "1":\n        name = input("Name: ")\n        score = int(input("Score: "))\n        scores[name] = max(scores.get(name, 0), score)\n    elif c == "2":\n        sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)\n        for rank, (n, s) in enumerate(sorted_scores, 1):\n            print(f"{rank}. {n}: {s}")\n    elif c == "3":\n        break'),
    s('sorted() with key','sorted(items, key=lambda x: x[1], reverse=True) sorts by score, highest first.')],
   q('What does reverse=True do in sorted()?',['Sorts alphabetically','Sorts from highest to lowest','Removes duplicates'],1)],

  ['l207','⚙️','Settings Manager','Store and update app settings.','Ages 10+',65,
   [s('Settings dict','settings = {\n    "theme": "dark",\n    "sound": True,\n    "difficulty": "medium"\n}'),
    s('Update settings','print("Current settings:", settings)\nkey = input("Setting to change: ").lower()\nif key in settings:\n    val = input(f"New value for {key}: ")\n    if val.lower() in ["true","false"]:\n        settings[key] = val.lower() == "true"\n    else:\n        settings[key] = val\n    print("Updated:", settings)'),
    s('Real apps','Real apps save settings to a file so they persist between runs.')],
   q('How do you check if a key exists in a dictionary?',['dict.contains(key)','key in dict','dict.has(key)'],1)],

  ['l208','🐛','Error Handling','Catch errors so apps don\'t crash.','Ages 10+',70,
   [s('The problem','int("hello") crashes your program!'),
    s('try/except','try:\n    num = int(input("Enter a number: "))\n    print("Double:", num * 2)\nexcept ValueError:\n    print("That\'s not a number!")'),
    s('Always catch errors','try/except lets your app handle mistakes gracefully instead of crashing.')],
   q('What does except ValueError catch?',['All errors','Errors when converting wrong data types','Network errors'],1)],

  ['l209','📋','Multi-Level Menu','Build a menu with submenus.','Ages 10+',70,
   [s('Nested menus','while True:\n    print("1.Games  2.Tools  3.Quit")\n    main = input(": ")\n    if main == "1":\n        print("  1.Guessing  2.Hangman  3.Back")\n        sub = input("  : ")\n        if sub == "1":\n            print("Starting guessing game...")\n        elif sub == "2":\n            print("Starting hangman...")\n    elif main == "2":\n        print("Tools menu coming soon!")\n    elif main == "3":\n        break'),
    s('Design tip','Submenus are just more while loops nested inside the main menu.')],
   q('How do you add a submenu?',['Use a second program','Nest another if/while inside the main menu choice','Use a class'],1)],

  ['l210','🔍','Search App','Build a searchable database.','Ages 10+',70,
   [s('Data setup','books = [\n    {"title":"Harry Potter","author":"Rowling"},\n    {"title":"Percy Jackson","author":"Riordan"},\n    {"title":"Matilda","author":"Dahl"}\n]'),
    s('Search function','def search(query, data):\n    results = []\n    for item in data:\n        if query.lower() in item["title"].lower():\n            results.append(item)\n    return results'),
    s('Use it','q = input("Search for: ")\nfound = search(q, books)\nfor b in found:\n    print(b["title"], "by", b["author"])')],
   q('What does .lower() help with when searching?',['Makes search case-insensitive','Speeds up search','Sorts results'],0)],

  ['l211','📱','App Project - Contact Book','Build a full contact book app.','Ages 10+',80,
   [s('Contact structure','contacts = {}\ndef add(name, phone, email):\n    contacts[name] = {"phone": phone, "email": email}'),
    s('Full app','while True:\n    print("1.Add  2.Find  3.List  4.Delete  5.Quit")\n    c = input(": ")\n    if c == "1":\n        n=input("Name: "); p=input("Phone: "); e=input("Email: ")\n        add(n,p,e); print("Added!")\n    elif c == "2":\n        n=input("Search: ")\n        if n in contacts: print(contacts[n])\n        else: print("Not found")\n    elif c == "3":\n        [print(k,v) for k,v in contacts.items()]\n    elif c == "4":\n        n=input("Delete: "); contacts.pop(n,None)\n    elif c == "5":\n        break'),
    s('Full app!','This is a real contact book. Every phone has one built-in!')],
   q('What does dict.pop(key, None) do?',['Crashes if key missing','Removes key, returns None if not found','Adds a key'],1)],

  ['l212','🌡️','App Project - Weather Logger','Build a temperature tracker.','Ages 10+',80,
   [s('Setup','readings = []\nwhile True:\n    print("1.Add reading  2.Stats  3.Show all  4.Quit")'),
    s('Add and stats','    c = input(": ")\n    if c == "1":\n        temp = float(input("Temp (°F): "))\n        readings.append(temp)\n    elif c == "2" and readings:\n        print(f"High: {max(readings)}°F")\n        print(f"Low: {min(readings)}°F")\n        print(f"Average: {sum(readings)/len(readings):.1f}°F")'),
    s('Show all','    elif c == "3":\n        for i,t in enumerate(readings,1):\n            print(f"Reading {i}: {t}°F")\n    elif c == "4":\n        break')],
   q('How do you find the average of a list?',['list.average()','sum(list) / len(list)','max(list) - min(list)'],1)],

  ['l213','🏋️','App Project - Fitness Tracker','Track workouts with code.','Ages 10+',80,
   [s('Workout log','log = []\nwhile True:\n    print("1.Log workout  2.Summary  3.Quit")'),
    s('Log it','    c = input(": ")\n    if c == "1":\n        ex = input("Exercise: ")\n        reps = int(input("Reps: "))\n        log.append({"exercise": ex, "reps": reps})'),
    s('Summary','    elif c == "2":\n        total = sum(w["reps"] for w in log)\n        print(f"Workouts: {len(log)}, Total reps: {total}")\n        for w in log:\n            print(f"  {w[\'exercise\']}: {w[\'reps\']} reps")\n    elif c == "3":\n        break')],
   q('What does a list of dictionaries let you store?',['Only numbers','Structured records with multiple fields','Only strings'],1)],
];

// ════════════════════════════════════════════════
// WORLD 19 — Champions Arena (unit 19) — 33 lessons
// ════════════════════════════════════════════════
const w19 = [
  ['l220','🏅','What Makes a Champion Coder?','Learn the mindset of great coders.','Ages 11+',50,
   [s('Champion mindset','Great coders don\'t memorize everything — they know how to think through problems.'),
    s('The 4 steps','1. Understand the problem\n2. Plan a solution\n3. Write the code\n4. Test and fix'),
    s('Debug like a pro','print("checkpoint:", variable) — add prints to see what your code is doing.')],
   q('What is step 2 in the coding process?',['Write the code','Plan a solution','Test and fix'],1)],

  ['l221','⚡','Code Efficiency','Write code that runs fast and clean.','Ages 11+',60,
   [s('Slow version','total = 0\nfor i in range(1, 101):\n    total += i\nprint(total)'),
    s('Fast version (math)','# Gauss formula: sum 1 to n = n*(n+1)/2\nn = 100\nprint(n * (n + 1) // 2)'),
    s('Same answer, way faster','The math formula is O(1) — instant. The loop is O(n) — slower as n grows.')],
   q('Which is faster for summing 1 to 1000000?',['A for loop','The formula n*(n+1)//2','They are the same'],1)],

  ['l222','🔍','Binary Search','Find items in half the time.','Ages 11+',65,
   [s('Linear vs Binary','Linear search: check each item one by one.\nBinary search: always check the middle, cut list in half.'),
    s('Binary search code','def binary_search(arr, target):\n    lo, hi = 0, len(arr) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if arr[mid] == target:\n            return mid\n        elif arr[mid] < target:\n            lo = mid + 1\n        else:\n            hi = mid - 1\n    return -1'),
    s('Test it','nums = [1,3,5,7,9,11,13,15]\nprint(binary_search(nums, 7))  # returns 3')],
   q('Binary search requires the list to be...?',['Random','Sorted','Reversed'],1)],

  ['l223','🫧','Bubble Sort','Sort a list by swapping neighbors.','Ages 11+',65,
   [s('Idea','Compare neighbors. If out of order, swap. Repeat until sorted.'),
    s('Code','def bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n-i-1):\n            if arr[j] > arr[j+1]:\n                arr[j], arr[j+1] = arr[j+1], arr[j]\n    return arr'),
    s('Test it','print(bubble_sort([5,3,8,1,9,2]))  # [1,2,3,5,8,9]')],
   q('In bubble sort, what happens when arr[j] > arr[j+1]?',['They are deleted','They are swapped','The sort stops'],1)],

  ['l224','⚡','Selection Sort','Find the smallest item each pass.','Ages 11+',65,
   [s('Idea','Find the minimum, put it first. Repeat for the rest.'),
    s('Code','def selection_sort(arr):\n    for i in range(len(arr)):\n        min_idx = i\n        for j in range(i+1, len(arr)):\n            if arr[j] < arr[min_idx]:\n                min_idx = j\n        arr[i], arr[min_idx] = arr[min_idx], arr[i]\n    return arr'),
    s('Test it','print(selection_sort([64,25,12,22,11]))  # [11,12,22,25,64]')],
   q('What does selection sort find each pass?',['The largest element','The minimum element in the unsorted part','A random element'],1)],

  ['l225','🗂️','Stack Data Structure','Last in, first out.','Ages 11+',65,
   [s('What is a stack?','Like a stack of plates: you add and remove from the TOP only. LIFO.'),
    s('Stack in Python','stack = []\nstack.append("first")\nstack.append("second")\nstack.append("third")\nprint(stack.pop())  # third\nprint(stack.pop())  # second'),
    s('Real use','Stacks are used in: undo buttons, browser back button, function calls.')],
   q('What does LIFO mean?',['Last In First Out','Large Items First Out','Last Index Found Only'],0)],

  ['l226','🚶','Queue Data Structure','First in, first out.','Ages 11+',65,
   [s('What is a queue?','Like a line at a shop: first person in is first to be served. FIFO.'),
    s('Queue in Python','from collections import deque\nqueue = deque()\nqueue.append("Alice")\nqueue.append("Bob")\nqueue.append("Charlie")\nprint(queue.popleft())  # Alice\nprint(queue.popleft())  # Bob'),
    s('Real use','Queues are used in: print spoolers, task schedulers, level order tree traversal.')],
   q('What does FIFO mean?',['First In First Out','Fast Items Fill Output','Final Index First Out'],0)],

  ['l227','🔁','Recursion Mastery','Functions that call themselves.','Ages 11+',70,
   [s('Recursion','A function that calls itself to solve a smaller version of the problem.'),
    s('Factorial','def factorial(n):\n    if n <= 1:  # base case\n        return 1\n    return n * factorial(n - 1)  # recursive case\nprint(factorial(5))  # 120'),
    s('Always need a base case','Without a base case, recursion never stops — infinite loop!')],
   q('What is the base case in recursion?',['The hardest case','The condition that stops the recursion','The first call'],1)],

  ['l228','🐇','Fibonacci Sequence','Calculate famous number patterns.','Ages 11+',65,
   [s('The sequence','0, 1, 1, 2, 3, 5, 8, 13... each number is the sum of the two before it.'),
    s('Iterative version','def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\nfor i in range(10):\n    print(fib(i), end=" ")'),
    s('Recursive version','def fib_r(n):\n    if n <= 1: return n\n    return fib_r(n-1) + fib_r(n-2)')],
   q('What is fib(7) in the Fibonacci sequence?',['8','13','7'],1)],

  ['l229','🗺️','2D Grid Navigation','Move through a 2D array.','Ages 11+',70,
   [s('Grid setup','grid = [\n    [".", ".", "#"],\n    [".", "#", "."],\n    [".", ".", "."]\n]\nrows, cols = 3, 3'),
    s('Print grid','for row in grid:\n    print(" ".join(row))'),
    s('Navigate','r, c = 0, 0  # start position\ndef move(direction):\n    global r, c\n    if direction == "down" and r < rows-1: r += 1\n    elif direction == "right" and c < cols-1: c += 1\n    print(f"Position: ({r},{c})")')],
   q('In a 2D grid, how do you access row 1, col 2?',['grid[2][1]','grid[1][2]','grid[1,2]'],1)],

  ['l230','🔢','Prime Numbers','Find primes with the Sieve of Eratosthenes.','Ages 11+',70,
   [s('What is prime?','A prime number is only divisible by 1 and itself: 2,3,5,7,11...'),
    s('Simple check','def is_prime(n):\n    if n < 2: return False\n    for i in range(2, int(n**0.5)+1):\n        if n % i == 0: return False\n    return True'),
    s('Print primes','primes = [n for n in range(2, 50) if is_prime(n)]\nprint(primes)')],
   q('Why check divisors up to √n only?',['It\'s faster and any factor above √n has a matching one below','It\'s a tradition','To avoid negative numbers'],0)],

  ['l231','🧮','GCD and LCM','Find greatest common divisor.','Ages 11+',65,
   [s('GCD','GCD = largest number that divides both evenly.'),
    s('Euclid\'s algorithm','def gcd(a, b):\n    while b:\n        a, b = b, a % b\n    return a\nprint(gcd(48, 18))  # 6'),
    s('LCM from GCD','def lcm(a, b):\n    return a * b // gcd(a, b)\nprint(lcm(4, 6))  # 12')],
   q('GCD stands for...?',['General Code Division','Greatest Common Divisor','Grand Count Digit'],1)],

  ['l232','🎯','Two-Pointer Technique','Solve array problems efficiently.','Ages 11+',70,
   [s('What is it?','Use two pointers moving toward each other to solve problems in O(n).'),
    s('Palindrome check','def is_palindrome(s):\n    left, right = 0, len(s) - 1\n    while left < right:\n        if s[left] != s[right]:\n            return False\n        left += 1\n        right -= 1\n    return True'),
    s('Test it','print(is_palindrome("racecar"))  # True\nprint(is_palindrome("hello"))   # False')],
   q('What is a palindrome?',['A type of loop','A word that reads the same forwards and backwards','A sorting algorithm'],1)],

  ['l233','🪟','Sliding Window','Process ranges of data efficiently.','Ages 11+',70,
   [s('The idea','Instead of recalculating the whole window, slide it and update only what changed.'),
    s('Max sum of k elements','def max_subarray(arr, k):\n    window = sum(arr[:k])\n    best = window\n    for i in range(k, len(arr)):\n        window += arr[i] - arr[i-k]\n        best = max(best, window)\n    return best'),
    s('Test it','print(max_subarray([2,1,5,1,3,2], 3))  # 9 (5+1+3)')],
   q('Why is sliding window efficient?',['It uses more memory','It avoids recalculating the whole window each step','It sorts the array first'],1)],

  ['l234','🗄️','Hash Maps in Python','Use dictionaries for O(1) lookups.','Ages 11+',70,
   [s('Hash map = dictionary','Python dicts are hash maps. Looking up any key takes O(1) — constant time!'),
    s('Two-sum problem','def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        complement = target - n\n        if complement in seen:\n            return [seen[complement], i]\n        seen[n] = i\n    return []'),
    s('Test it','print(two_sum([2,7,11,15], 9))  # [0, 1]')],
   q('What makes dictionary lookup O(1)?',['It searches every item','Hash maps jump directly to the value without searching','It sorts first'],1)],

  ['l235','♟️','Greedy Algorithms','Make the best local choice each step.','Ages 11+',70,
   [s('Greedy idea','Always pick the best option right now, without looking ahead.'),
    s('Coin change (greedy)','def greedy_coins(amount, coins=[25,10,5,1]):\n    result = []\n    for coin in coins:\n        while amount >= coin:\n            result.append(coin)\n            amount -= coin\n    return result'),
    s('Test it','print(greedy_coins(41))  # [25,10,5,1]')],
   q('Greedy algorithms work best when...?',['The locally best choice leads to the global best solution','You need to try all options','The data is sorted'],0)],

  ['l236','🧠','Memoization','Cache results to speed up recursion.','Ages 11+',75,
   [s('The problem','Recursive fibonacci recalculates the same values over and over — very slow!'),
    s('Memoize it','cache = {}\ndef fib_memo(n):\n    if n in cache: return cache[n]\n    if n <= 1: return n\n    cache[n] = fib_memo(n-1) + fib_memo(n-2)\n    return cache[n]'),
    s('Or use Python shortcut','from functools import lru_cache\n@lru_cache(maxsize=None)\ndef fib(n):\n    if n <= 1: return n\n    return fib(n-1) + fib(n-2)')],
   q('What does memoization do?',['Deletes old results','Caches (saves) results so they\'re not recalculated','Sorts the results'],1)],

  ['l237','🌲','Binary Trees','Understand hierarchical data structures.','Ages 11+',75,
   [s('What is a tree?','A tree has a root node, and each node can have children. No loops.'),
    s('Node class','class Node:\n    def __init__(self, val):\n        self.val = val\n        self.left = None\n        self.right = None'),
    s('Build a tree','root = Node(1)\nroot.left = Node(2)\nroot.right = Node(3)\nroot.left.left = Node(4)\nprint("Root:", root.val)\nprint("Left child:", root.left.val)')],
   q('In a binary tree, each node can have at most...?',['1 child','2 children','3 children'],1)],

  ['l238','🔄','Tree Traversal','Visit every node in a tree.','Ages 11+',75,
   [s('3 ways to traverse','In-order: left → root → right\nPre-order: root → left → right\nPost-order: left → right → root'),
    s('In-order code','def inorder(node):\n    if node:\n        inorder(node.left)\n        print(node.val, end=" ")\n        inorder(node.right)'),
    s('Test it (BST)','# For a binary search tree, inorder gives sorted output!\n# root=4, left=2, right=6, 2.left=1, 2.right=3\n# inorder → 1 2 3 4 6')],
   q('What order does inorder traversal visit nodes?',['Root, Left, Right','Left, Root, Right','Right, Root, Left'],1)],

  ['l239','🎪','Backtracking','Try all options, undo bad choices.','Ages 11+',75,
   [s('What is backtracking?','Try a choice. If it fails, undo it and try another. Like solving a maze.'),
    s('All permutations','def permutations(arr, current=[]):\n    if not arr:\n        print(current)\n        return\n    for i in range(len(arr)):\n        permutations(arr[:i] + arr[i+1:], current + [arr[i]])'),
    s('Test it','permutations([1,2,3])\n# Prints all 6 arrangements: [1,2,3] [1,3,2] [2,1,3] etc.')],
   q('In backtracking, what happens when a path fails?',['The program crashes','We undo the last choice and try another','We skip to the end'],1)],

  ['l240','📐','Big O Basics','Measure how fast your code scales.','Ages 11+',70,
   [s('What is Big O?','Big O describes how runtime grows as input size (n) grows.'),
    s('Common examples','O(1) - constant: dict lookup\nO(n) - linear: for loop\nO(n²) - quadratic: nested loops\nO(log n) - logarithmic: binary search'),
    s('Why it matters','O(1) handles a million items instantly.\nO(n²) with a million items = a trillion operations!')],
   q('What is the Big O of a single for loop?',['O(1)','O(n)','O(n²)'],1)],

  ['l241','🏁','String Algorithms','Search for patterns in strings.','Ages 11+',70,
   [s('Substring check','text = "Hello, KidVibers!"\nprint("Vibers" in text)  # True'),
    s('Count occurrences','def count_word(text, word):\n    count = 0\n    start = 0\n    while True:\n        pos = text.find(word, start)\n        if pos == -1: break\n        count += 1\n        start = pos + 1\n    return count'),
    s('Test it','print(count_word("banana", "an"))  # 2')],
   q('What does str.find() return if not found?',['0','None','-1'],2)],

  ['l242','🎮','Challenge Round 1','Solve classic coding challenges.','Ages 11+',80,
   [s('Challenge 1: FizzBuzz','for i in range(1, 31):\n    if i % 15 == 0: print("FizzBuzz")\n    elif i % 3 == 0: print("Fizz")\n    elif i % 5 == 0: print("Buzz")\n    else: print(i)'),
    s('Challenge 2: Reverse a string','s = "KidVibers"\nprint(s[::-1])  # srebiVdiK'),
    s('Challenge 3: Sum of digits','def digit_sum(n):\n    return sum(int(d) for d in str(n))\nprint(digit_sum(12345))  # 15')],
   q('What does s[::-1] do?',['Sorts the string','Reverses the string','Removes spaces'],1)],

  ['l243','🎯','Challenge Round 2','More classic problems.','Ages 11+',80,
   [s('Challenge 1: Anagram check','def is_anagram(a, b):\n    return sorted(a.lower()) == sorted(b.lower())\nprint(is_anagram("listen", "silent"))  # True'),
    s('Challenge 2: Count vowels','def count_vowels(s):\n    return sum(1 for c in s.lower() if c in "aeiou")\nprint(count_vowels("KidVibers"))  # 3'),
    s('Challenge 3: Flatten a list','nested = [[1,2],[3,4],[5,6]]\nflat = [x for sublist in nested for x in sublist]\nprint(flat)  # [1,2,3,4,5,6]')],
   q('What does sorted(string) do?',['Reverses the string','Returns a sorted list of characters','Counts characters'],1)],

  ['l244','⚡','Challenge Round 3','Advanced challenges.','Ages 11+',80,
   [s('Challenge 1: Matrix transpose','matrix = [[1,2,3],[4,5,6],[7,8,9]]\ntransposed = [[row[i] for row in matrix] for i in range(3)]\nfor row in transposed: print(row)'),
    s('Challenge 2: Most frequent element','from collections import Counter\nnums = [1,2,2,3,3,3,4]\nc = Counter(nums)\nprint(c.most_common(1))  # [(3,3)]'),
    s('Challenge 3: Palindrome number','def is_pal_num(n):\n    s = str(n)\n    return s == s[::-1]\nprint(is_pal_num(121))  # True')],
   q('What does Counter.most_common(1) return?',['The total count','The single most common element and its count','The least common element'],1)],

  ['l245','🏆','Mock Contest 1','Timed problem-solving practice.','Ages 12+',90,
   [s('Problem 1 - Two Sum','Given a list and target, find two indices that sum to target.\n\ndef two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target-n], i]\n        seen[n] = i\nnums = [2, 7, 11, 15]\nprint(two_sum(nums, 9))  # [0, 1]'),
    s('Problem 2 - Max Profit','Best time to buy and sell stock:\ndef max_profit(prices):\n    min_p = prices[0]\n    best = 0\n    for p in prices:\n        min_p = min(min_p, p)\n        best = max(best, p - min_p)\n    return best\nprint(max_profit([7,1,5,3,6,4]))  # 5'),
    s('Champion tip','Always think: Can I do this in one pass? Can I use a hash map?')],
   q('In the two-sum solution, what is "seen" used for?',['Sorting numbers','Storing values we\'ve seen and their indices','Counting duplicates'],1)],

  ['l246','🎯','Mock Contest 2','More timed problems.','Ages 12+',90,
   [s('Problem 1 - Valid Parentheses','def is_valid(s):\n    stack = []\n    pairs = {")"  :"(", "}":"{", "]":"["}\n    for c in s:\n        if c in "([{":\n            stack.append(c)\n        elif c in pairs:\n            if not stack or stack[-1] != pairs[c]:\n                return False\n            stack.pop()\n    return not stack\nprint(is_valid("()[]{}"))  # True\nprint(is_valid("([)]"))    # False'),
    s('Problem 2 - Missing Number','def missing(nums):\n    n = len(nums)\n    return n*(n+1)//2 - sum(nums)\nprint(missing([3,0,1]))  # 2'),
    s('Key skill','For bracket problems, always think: STACK.')],
   q('What data structure is perfect for matching parentheses?',['Queue','Stack','Dictionary'],1)],

  ['l247','🌟','Build Your Showcase Project','Create an impressive final project.','Ages 12+',100,
   [s('Plan your project','Choose one:\n• A text RPG with inventory and combat\n• A student grade book\n• A personal finance tracker\n• A mini social network (users + posts)'),
    s('Grade book example','grades = {}\nwhile True:\n    print("1.Add grade  2.Average  3.Report  4.Quit")\n    c = input(": ")\n    if c == "1":\n        n = input("Student: ")\n        g = float(input("Grade: "))\n        grades.setdefault(n, []).append(g)\n    elif c == "2":\n        n = input("Student: ")\n        avg = sum(grades[n])/len(grades[n])\n        print(f"{n}: {avg:.1f}")\n    elif c == "3":\n        for n,gs in grades.items():\n            print(f"{n}: {sum(gs)/len(gs):.1f}")\n    elif c == "4":\n        break'),
    s('You are a champion!','You\'ve learned: variables, loops, functions, data structures, algorithms, OOP, and more.')],
   q('What does dict.setdefault(key, []) do?',['Raises error if key missing','Returns existing value or sets key to default if missing','Deletes the key'],1)],

  ['l248','🎖️','Champion Review - Part 1','Review core concepts.','Ages 11+',70,
   [s('Data structure review','List → ordered, duplicates OK\nDict → key:value, fast lookup\nSet → unique items, fast membership\nTuple → immutable list'),
    s('When to use what?','Need order? → list\nNeed fast lookup? → dict\nNeed unique items? → set\nNeed to protect data? → tuple'),
    s('Quick test','names = ["Alice","Bob","Alice"]\nuniq = set(names)\nprint(uniq)  # {"Alice","Bob"}')],
   q('Which structure automatically removes duplicates?',['List','Dictionary','Set'],2)],

  ['l249','🎖️','Champion Review - Part 2','Review algorithms.','Ages 11+',70,
   [s('Algorithm review','Binary search → O(log n), needs sorted array\nBubble sort → O(n²), simple\nHash map lookup → O(1), fastest\nRecursion → breaks problems down'),
    s('Pattern matching','Sliding window → range sums\nTwo pointers → palindromes, two-sum in sorted\nBacktracking → permutations, maze solving\nGreedy → coin change, scheduling'),
    s('Final tip','For every problem, ask: what data structure makes this easy?')],
   q('Which algorithm is best for finding an item in a sorted list?',['Linear search','Bubble sort','Binary search'],2)],

  ['l250','🏆','The Grand Master Boss Prep','Final review for the Championship.','Ages 12+',100,
   [s('You have learned...','✅ Python basics\n✅ Data structures (lists, dicts, sets, tuples)\n✅ Algorithms (search, sort, recursion)\n✅ OOP (classes, objects)\n✅ App building\n✅ Creative coding\n✅ Error handling\n✅ Problem solving patterns'),
    s('Boss strategies','1. Read carefully — understand before coding\n2. Start simple — get it working, then optimize\n3. Test edge cases — empty input, one item, max size\n4. Use the right data structure — it makes everything easier'),
    s('You are ready!','The Grand Master awaits. Give it everything you\'ve got. 👑')],
   q('What is the most important first step when solving a coding problem?',['Start typing code immediately','Read and understand the problem fully','Copy a solution'],1)],
];

// ══════════════════════════════════════════════
// INSERT ALL LESSONS
// ══════════════════════════════════════════════
async function main() {
  basePos = getMaxPos() + 1;
  console.log('Starting position:', basePos);

  const allLessons = [
    ...w17.map((l, i) => [...l.slice(0,2), 17, basePos + i, ...l.slice(2)]),
    ...w18.map((l, i) => [...l.slice(0,2), 18, basePos + w17.length + i, ...l.slice(2)]),
    ...w19.map((l, i) => [...l.slice(0,2), 19, basePos + w17.length + w18.length + i, ...l.slice(2)]),
  ];

  let count = 0;
  for (const l of allLessons) {
    const [id, emoji, unit, pos, title, blurb, level, xp, steps, quiz] = l;
    const cmd = lesson(id, unit, pos, emoji, title, blurb, level, xp, steps, quiz);
    sql(cmd);
    count++;
    if (count % 10 === 0) console.log(`Inserted ${count}/${allLessons.length}...`);
  }
  console.log(`✅ Done! Inserted ${count} lessons.`);
}

main();
