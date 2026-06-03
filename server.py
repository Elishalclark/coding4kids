#!/usr/bin/env python3
"""
Coding4Kids backend — pure Python standard library (no pip installs needed).

Roles:
  kid          - signs up, does lessons, AI if their plan allows
  parent       - creates a Family account, adds kids (kids inherit Family AI),
                 sees ONLY their own family's plan + kids
  admin        - read-only staff: dashboard, stats, all users
  super_admin  - full control: change plans, edit plan/chat limits, manage lessons

Plan + AI gating (driven by editable settings):
  each plan has  { ai: bool, chatsPerDay: int }   (-1 = unlimited daily chats)
  defaults: free/trial -> no AI; pro -> 100 chats/day; family -> unlimited

Run:  python3 server.py      (PORT env var optional, default 3000)
"""

import json
import os
import re
import sqlite3
import hashlib
import secrets
import datetime
import time
import threading
import urllib.request
import smtplib
import ssl
import html as html_lib
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
# DATA_DIR lets a host keep the database + secrets on a persistent disk (e.g. Render disk at /data).
DATA_DIR = os.environ.get("DATA_DIR", ROOT)
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "data.db")
ADMIN_CONFIG = os.path.join(DATA_DIR, "admin_config.json")
PORT = int(os.environ.get("PORT", "3000"))

TRIAL_DAYS = 3
ADMIN_ROLES = ("admin", "super_admin")
GUARDIAN_ROLES = ("parent", "teacher")   # adults who manage kids
COPPA_AGE = 13                            # under this age, verifiable consent is required (US COPPA)
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
}

# chatsPerDay / lessonLimit:  -1 = unlimited
DEFAULT_PLAN_SETTINGS = {
    "free":   {"ai": False, "chatsPerDay": 0,   "lessonLimit": 3},
    "trial":  {"ai": False, "chatsPerDay": 0,   "lessonLimit": 5},
    "pro":    {"ai": True,  "chatsPerDay": 100, "lessonLimit": -1},
    "family": {"ai": True,  "chatsPerDay": -1,  "lessonLimit": -1},
}

PASS_PERCENT = 70  # score needed on a boss battle to level up

# Each unit is a themed WORLD with a boss battle (the unit test) at the end.
WORLDS = {
    1:  {"name": "Greenwood Basics", "emoji": "🌱", "color": "#34d399",
         "tagline": "Where every coder's adventure begins.", "boss": {"name": "Buggle the Glitch", "emoji": "🐛"}},
    2:  {"name": "Builder's Bay", "emoji": "🌊", "color": "#0ea5e9",
         "tagline": "Loops, choices and functions by the sea.", "boss": {"name": "Krakode", "emoji": "🦑"}},
    3:  {"name": "Cosmic Code Station", "emoji": "🚀", "color": "#a78bfa",
         "tagline": "Master data among the stars.", "boss": {"name": "Glitchoid", "emoji": "👾"}},
    4:  {"name": "Algorithm Castle", "emoji": "🏰", "color": "#f59e0b",
         "tagline": "Conquer the ancient algorithms.", "boss": {"name": "Recursor the Dragon", "emoji": "🐉"}},
    5:  {"name": "Game Arcade", "emoji": "🎮", "color": "#ef4444",
         "tagline": "Build the logic behind real games.", "boss": {"name": "Pixel Phantom", "emoji": "🕹️"}},
    6:  {"name": "Web Wizard Woods", "emoji": "🌐", "color": "#22c55e",
         "tagline": "Craft pages with HTML & CSS magic.", "boss": {"name": "Taggon the Troll", "emoji": "🧌"}},
    7:  {"name": "JavaScript Junction", "emoji": "⚡", "color": "#eab308",
         "tagline": "Bring web pages to life.", "boss": {"name": "Scriptasaurus", "emoji": "🦖"}},
    8:  {"name": "AI Island", "emoji": "🤖", "color": "#06b6d4",
         "tagline": "Discover how smart machines think.", "boss": {"name": "Mecha-Mind", "emoji": "🧠"}},
    9:  {"name": "Math Mountain", "emoji": "🔢", "color": "#f472b6",
         "tagline": "Power up with math in code.", "boss": {"name": "Count Calculon", "emoji": "🧮"}},
    10: {"name": "Master's Summit", "emoji": "🏆", "color": "#f59e0b",
         "tagline": "Combine everything you've learned.", "boss": {"name": "The Grand Compiler", "emoji": "👑"}},
}
UNIT_NAMES = {u: f"{w['emoji']} {w['name']}" for u, w in WORLDS.items()}

# Teacher / school subscription tiers (how many students an educator account can have).
# No free tier — a teacher must subscribe to add students.
TEACHER_PLANS = {
    "teacher":   {"label": "Teacher Plan",   "price": 18,  "students": 150},
    "school":    {"label": "School Plan",    "price": 100, "students": 550},
}
NO_TEACHER_PLAN = {"label": "No plan yet", "price": 0, "students": 0}

TOKENS_PER_LESSON = 10   # coins earned per newly completed lesson
STARTER_TOKENS = 40      # coins a new account starts with

# Avatar shop catalog. cat: face | hat | accessory | clothing | companion | background
SHOP_ITEMS = [
    {"id": "face_kid",   "name": "Classic",     "cat": "face",       "emoji": "🧒", "price": 0},
    {"id": "face_cool",  "name": "Cool Kid",    "cat": "face",       "emoji": "😎", "price": 15},
    {"id": "face_star",  "name": "Star Eyes",   "cat": "face",       "emoji": "🤩", "price": 25},
    {"id": "face_robot", "name": "Robot",       "cat": "face",       "emoji": "🤖", "price": 30},
    {"id": "face_alien", "name": "Alien",       "cat": "face",       "emoji": "👽", "price": 30},
    {"id": "hat_cap",    "name": "Cap",         "cat": "hat",        "emoji": "🧢", "price": 20},
    {"id": "hat_top",    "name": "Top Hat",     "cat": "hat",        "emoji": "🎩", "price": 40},
    {"id": "hat_grad",   "name": "Grad Cap",    "cat": "hat",        "emoji": "🎓", "price": 50},
    {"id": "hat_crown",  "name": "Crown",       "cat": "hat",        "emoji": "👑", "price": 90},
    {"id": "hat_party",  "name": "Party Hat",   "cat": "hat",        "emoji": "🥳", "price": 35},
    {"id": "acc_glass",  "name": "Glasses",     "cat": "accessory",  "emoji": "👓", "price": 20},
    {"id": "acc_shades", "name": "Cool Shades", "cat": "accessory",  "emoji": "🕶️", "price": 35},
    {"id": "acc_bow",    "name": "Bow",         "cat": "accessory",  "emoji": "🎀", "price": 25},
    {"id": "acc_medal",  "name": "Medal",       "cat": "accessory",  "emoji": "🏅", "price": 45},
    {"id": "cloth_tee",  "name": "T-Shirt",     "cat": "clothing",   "emoji": "👕", "price": 15},
    {"id": "cloth_hood", "name": "Hoodie",      "cat": "clothing",   "emoji": "🧥", "price": 40},
    {"id": "cloth_lab",  "name": "Lab Coat",    "cat": "clothing",   "emoji": "🥼", "price": 55},
    {"id": "pet_cat",    "name": "Cat Buddy",   "cat": "companion",  "emoji": "🐱", "price": 70},
    {"id": "pet_dog",    "name": "Dog Buddy",   "cat": "companion",  "emoji": "🐶", "price": 70},
    {"id": "pet_bot",    "name": "Robot Pal",   "cat": "companion",  "emoji": "🤖", "price": 100},
    {"id": "bg_purple",  "name": "Purple",      "cat": "background",  "color": "#7c3aed", "price": 0},
    {"id": "bg_blue",    "name": "Ocean",       "cat": "background",  "color": "#0ea5e9", "price": 20},
    {"id": "bg_green",   "name": "Jungle",      "cat": "background",  "color": "#10b981", "price": 20},
    {"id": "bg_pink",    "name": "Bubblegum",   "cat": "background",  "color": "#ec4899", "price": 25},
    {"id": "bg_gold",    "name": "Gold",        "cat": "background",  "color": "#f59e0b", "price": 60},
]
FREE_ITEMS = [i["id"] for i in SHOP_ITEMS if i.get("price", 0) == 0]
DEFAULT_AVATAR = {"face": "face_kid", "hat": None, "accessory": None, "clothing": None, "companion": None, "background": "bg_purple"}
SHOP_BY_ID = {i["id"]: i for i in SHOP_ITEMS}

# ── 100-lesson curriculum: 10 worlds × 10 lessons. Keys: e,t,b,lv,xp,p,c,q,o,a,x ──
CURRICULUM = [
 [  # World 1 · Greenwood Basics
  {"e":"🖨️","t":"Say Hello with Print","b":"Make the computer talk!","lv":"Ages 6+","xp":40,"p":"The <code>print</code> command shows words on the screen.","c":"print('Hello!')","q":"How do you show the word Hi?","o":["print(Hi)","print('Hi')","show Hi"],"a":1,"x":"Put text in quotes inside print(): print('Hi')."},
  {"e":"💬","t":"Code Comments","b":"Leave notes for humans.","lv":"Ages 6+","xp":40,"p":"A comment starts with <code>#</code> and is a note Python ignores.","c":"# this is a note\nprint('hi')","q":"What starts a Python comment?","o":["//","#","--"],"a":1,"x":"In Python, comments start with the # symbol."},
  {"e":"🔤","t":"Strings (Text)","b":"Words live in quotes.","lv":"Ages 6+","xp":45,"p":"Text wrapped in quotes is called a string.","c":"name = 'Sam'","q":"Which one is a string?","o":["'hello'","42","True"],"a":0,"x":"A string is text in quotes, like 'hello'."},
  {"e":"📦","t":"Variables","b":"Store values in a box.","lv":"Ages 7+","xp":45,"p":"A variable stores a value under a name.","c":"score = 10","q":"How do you store 10 in score?","o":["score = 10","10 = score","score == 10"],"a":0,"x":"Name first, then =, then the value: score = 10."},
  {"e":"➕","t":"Numbers & Math","b":"Python is a calculator.","lv":"Ages 7+","xp":45,"p":"Python adds, subtracts and more with numbers.","c":"print(2 + 3)","q":"What does 2 + 3 print?","o":["23","5","'2+3'"],"a":1,"x":"Numbers add up: 2 + 3 equals 5."},
  {"e":"⌨️","t":"Asking for Input","b":"Let the user type.","lv":"Ages 7+","xp":50,"p":"<code>input()</code> waits for the user to type something.","c":"name = input('Name? ')","q":"What does input() do?","o":["prints text","gets what the user types","deletes text"],"a":1,"x":"input() waits for the user to type, then gives it back."},
  {"e":"✅","t":"True or False","b":"Meet booleans.","lv":"Ages 7+","xp":50,"p":"A boolean is either <code>True</code> or <code>False</code>.","c":"is_happy = True","q":"Which is a boolean?","o":["'yes'","True","5"],"a":1,"x":"Booleans can only be True or False."},
  {"e":"🤔","t":"If Statements","b":"Make a choice.","lv":"Ages 8+","xp":55,"p":"<code>if</code> runs code only when something is true.","c":"if score > 5:\n    print('win')","q":"What ends an if line?","o":[";",":","."],"a":1,"x":"An if line ends with a colon ( : )."},
  {"e":"🔀","t":"Else","b":"The other path.","lv":"Ages 8+","xp":55,"p":"<code>else</code> runs when the if was not true.","c":"if x > 5:\n    print('big')\nelse:\n    print('small')","q":"When does else run?","o":["always","when the if is false","never"],"a":1,"x":"else runs only when the if condition is false."},
  {"e":"⚖️","t":"Comparing Values","b":"Equal, greater, less.","lv":"Ages 8+","xp":55,"p":"Use <code>==</code> for equal, <code>></code> greater, <code><</code> less.","c":"print(3 > 2)","q":"Which checks 'is equal'?","o":["=","==","=>"],"a":1,"x":"Use == to compare; a single = stores a value."},
 ],
 [  # World 2 · Builder's Bay
  {"e":"🪜","t":"elif","b":"More than two choices.","lv":"Ages 8+","xp":60,"p":"<code>elif</code> checks another condition if the first was false.","c":"if x>10:\n    print('big')\nelif x>5:\n    print('mid')","q":"elif is short for?","o":["else if","end if","every if"],"a":0,"x":"elif means 'else if' - another condition to check."},
  {"e":"🔗","t":"and","b":"Both must be true.","lv":"Ages 8+","xp":60,"p":"<code>and</code> is true only if BOTH sides are true.","c":"if a>0 and b>0:\n    print('both')","q":"a and b is True when?","o":["either is true","both are true","neither"],"a":1,"x":"and needs both sides to be true."},
  {"e":"🔱","t":"or","b":"At least one.","lv":"Ages 8+","xp":60,"p":"<code>or</code> is true if at least one side is true.","c":"if rainy or cold:\n    print('stay in')","q":"or is True when?","o":["both false","at least one is true","only both true"],"a":1,"x":"or is true if at least one side is true."},
  {"e":"🚫","t":"not","b":"Flip it around.","lv":"Ages 8+","xp":60,"p":"<code>not</code> flips True to False and back.","c":"print(not True)","q":"not True is?","o":["True","False","None"],"a":1,"x":"not flips the value, so not True is False."},
  {"e":"🔁","t":"For Loops","b":"Do it for each.","lv":"Ages 8+","xp":65,"p":"A <code>for</code> loop repeats once for each item or number.","c":"for i in range(3):\n    print(i)","q":"A for loop runs?","o":["once for each item","one time","never"],"a":0,"x":"A for loop runs once for each item in a sequence."},
  {"e":"🔄","t":"While Loops","b":"Keep going.","lv":"Ages 9+","xp":65,"p":"A <code>while</code> loop repeats while a condition stays true.","c":"while x < 5:\n    x = x + 1","q":"A while loop stops when?","o":["the condition is false","forever","after once"],"a":0,"x":"A while loop stops when its condition becomes false."},
  {"e":"🔢","t":"range()","b":"Count made easy.","lv":"Ages 9+","xp":65,"p":"<code>range(n)</code> gives numbers from 0 up to n-1.","c":"for i in range(4):\n    print(i)","q":"range(4) gives?","o":["1 2 3 4","0 1 2 3","0 1 2 3 4"],"a":1,"x":"range(4) is 0,1,2,3 - four numbers starting at 0."},
  {"e":"🛑","t":"break","b":"Stop early.","lv":"Ages 9+","xp":65,"p":"<code>break</code> stops a loop right away.","c":"for i in range(10):\n    if i==3:\n        break","q":"break does what?","o":["skips one","stops the loop","restarts"],"a":1,"x":"break exits the loop immediately."},
  {"e":"🛠️","t":"Functions","b":"Reusable powers.","lv":"Ages 9+","xp":70,"p":"<code>def</code> makes a reusable function.","c":"def hi():\n    print('hi')","q":"Which keyword makes a function?","o":["func","def","fun"],"a":1,"x":"Use def to define a function."},
  {"e":"↩️","t":"return","b":"Send a value back.","lv":"Ages 9+","xp":70,"p":"<code>return</code> sends a value back from a function.","c":"def add(a,b):\n    return a+b","q":"return does what?","o":["prints text","sends a value back","loops"],"a":1,"x":"return gives a value back to whoever called the function."},
 ],
 [  # World 3 · Cosmic Code Station
  {"e":"🎒","t":"Lists","b":"Carry many items.","lv":"Ages 9+","xp":75,"p":"A list holds many items in order, inside <code>[ ]</code>.","c":"loot = ['gem','key']","q":"Which makes a list?","o":["(1,2)","[1,2]","{1,2}"],"a":1,"x":"Lists use square brackets: [1, 2]."},
  {"e":"🔟","t":"List Index","b":"Counting from 0.","lv":"Ages 9+","xp":75,"p":"Lists count from 0; the first item is <code>[0]</code>.","c":"print(loot[0])","q":"The first item's index is?","o":["0","1","-1"],"a":0,"x":"Indexes start at 0, so the first item is [0]."},
  {"e":"➕","t":"append()","b":"Add to a list.","lv":"Ages 9+","xp":75,"p":"<code>append</code> adds an item to the end of a list.","c":"loot.append('map')","q":"append adds where?","o":["the start","the end","the middle"],"a":1,"x":"append puts the new item at the end."},
  {"e":"📏","t":"len()","b":"How many?","lv":"Ages 9+","xp":80,"p":"<code>len()</code> counts how many items there are.","c":"print(len(loot))","q":"len([1,2,3]) is?","o":["2","3","4"],"a":1,"x":"len counts items - [1,2,3] has 3."},
  {"e":"🔁","t":"Loop a List","b":"Visit every item.","lv":"Ages 10+","xp":80,"p":"A for loop can visit every item in a list.","c":"for x in loot:\n    print(x)","q":"for x in loot does?","o":["one item","every item","no items"],"a":1,"x":"It visits each item in the list, one by one."},
  {"e":"✂️","t":"String Index","b":"Letters have spots.","lv":"Ages 10+","xp":80,"p":"Strings are indexed like lists; <code>'cat'[0]</code> is 'c'.","c":"print('cat'[0])","q":"'cat'[0] is?","o":["'c'","'a'","'t'"],"a":0,"x":"Index 0 is the first letter, 'c'."},
  {"e":"🔠","t":"String Methods","b":"UPPER and lower.","lv":"Ages 10+","xp":85,"p":"<code>.upper()</code> makes text UPPERCASE.","c":"print('hi'.upper())","q":"'hi'.upper() gives?","o":["'hi'","'HI'","'Hi'"],"a":1,"x":".upper() turns letters uppercase: HI."},
  {"e":"🧩","t":"f-strings","b":"Mix text and values.","lv":"Ages 10+","xp":85,"p":"An f-string puts variables inside text with <code>{ }</code>.","c":"print(f'Hi {name}')","q":"What lets you drop a variable into a string?","o":["f-string","g-string","q-string"],"a":0,"x":"An f-string (f'...') inserts variables using { }."},
  {"e":"🗃️","t":"Dictionaries","b":"Labeled lockers.","lv":"Ages 10+","xp":90,"p":"A dictionary stores <code>key: value</code> pairs in <code>{ }</code>.","c":"p = {'hp': 100}","q":"Dictionaries store?","o":["only numbers","key-value pairs","just text"],"a":1,"x":"Dictionaries map a key to a value."},
  {"e":"🔑","t":"Reading a Dict","b":"Look it up.","lv":"Ages 10+","xp":90,"p":"Use the key to read a value: <code>p['hp']</code>.","c":"print(p['hp'])","q":"How do you read hp from p?","o":["p(hp)","p['hp']","p.hp()"],"a":1,"x":"Use square brackets with the key: p['hp']."},
 ],
 [  # World 4 · Algorithm Castle
  {"e":"🔢","t":"Sorting","b":"Put it in order.","lv":"Ages 10+","xp":95,"p":"<code>.sort()</code> orders a list from small to big.","c":"nums.sort()","q":"sort() orders how?","o":["randomly","small to big","big to small"],"a":1,"x":".sort() arranges from smallest to largest."},
  {"e":"⬆️","t":"max()","b":"Find the biggest.","lv":"Ages 10+","xp":95,"p":"<code>max()</code> finds the biggest value.","c":"print(max([3,9,1]))","q":"max([3,9,1]) is?","o":["3","9","1"],"a":1,"x":"max returns the largest item, 9."},
  {"e":"⬇️","t":"min()","b":"Find the smallest.","lv":"Ages 10+","xp":95,"p":"<code>min()</code> finds the smallest value.","c":"print(min([3,9,1]))","q":"min([3,9,1]) is?","o":["3","1","9"],"a":1,"x":"min returns the smallest item, 1."},
  {"e":"➗","t":"sum()","b":"Add them all.","lv":"Ages 10+","xp":95,"p":"<code>sum()</code> adds all the numbers in a list.","c":"print(sum([1,2,3]))","q":"sum([1,2,3]) is?","o":["6","123","3"],"a":0,"x":"sum adds them: 1+2+3 = 6."},
  {"e":"🔎","t":"The in Keyword","b":"Is it inside?","lv":"Ages 10+","xp":100,"p":"<code>in</code> checks if something is inside a list or string.","c":"print('a' in 'cat')","q":"'a' in 'cat' is?","o":["True","False","'a'"],"a":0,"x":"'a' is inside 'cat', so it's True."},
  {"e":"🪆","t":"Nested If","b":"Ifs inside ifs.","lv":"Ages 11+","xp":100,"p":"An if inside another if checks two things in steps.","c":"if a>0:\n    if b>0:\n        print('both +')","q":"An if inside an if is called?","o":["nested","looped","broken"],"a":0,"x":"An if inside another if is 'nested'."},
  {"e":"🔳","t":"Nested Loops","b":"Loops inside loops.","lv":"Ages 11+","xp":100,"p":"A loop inside a loop repeats a repeat - great for grids.","c":"for r in range(2):\n    for c in range(2):\n        print(r,c)","q":"A loop inside a loop is a?","o":["nested loop","broken loop","for-each"],"a":0,"x":"Loops inside loops are nested loops."},
  {"e":"🧮","t":"Counters","b":"Count things up.","lv":"Ages 10+","xp":100,"p":"Add 1 to a variable to count things.","c":"count = count + 1","q":"count = count + 1 does?","o":["resets it","adds one","doubles it"],"a":1,"x":"It increases count by 1 each time."},
  {"e":"🧺","t":"Accumulator","b":"Build a total.","lv":"Ages 11+","xp":105,"p":"Build up a total by adding inside a loop.","c":"total = 0\nfor n in nums:\n    total += n","q":"total += n means?","o":["total = n","total = total + n","total - n"],"a":1,"x":"+= adds n onto the running total."},
  {"e":"🔍","t":"Debugging","b":"Be a code detective.","lv":"Ages 11+","xp":105,"p":"Read the error's LAST line first to find the problem.","c":"print(score)  # peek at it","q":"A good first debugging step is to?","o":["delete all code","read the last error line","restart the computer"],"a":1,"x":"The last line of an error tells you what went wrong."},
 ],
 [  # World 5 · Game Arcade
  {"e":"🎲","t":"Randomness","b":"Roll the dice.","lv":"Ages 10+","xp":100,"p":"<code>random.randint(1,6)</code> rolls a number from 1 to 6.","c":"import random\nrandom.randint(1,6)","q":"randint(1,6) gives?","o":["1 to 6","0 to 6","1 to 5"],"a":0,"x":"randint(1,6) gives any whole number from 1 to 6."},
  {"e":"🔁","t":"The Game Loop","b":"Update every frame.","lv":"Ages 10+","xp":105,"p":"Games run a loop that updates every frame.","c":"while playing:\n    update()","q":"A game loop is usually a?","o":["while loop","function","list"],"a":0,"x":"Games use a while loop that runs each frame."},
  {"e":"🏅","t":"Keeping Score","b":"Earn points.","lv":"Ages 10+","xp":105,"p":"Keep score in a variable and add points.","c":"score += 10","q":"How do you add 10 points?","o":["score = 10","score += 10","score - 10"],"a":1,"x":"score += 10 adds 10 to the score."},
  {"e":"❤️","t":"Lives & Health","b":"Don't hit zero!","lv":"Ages 10+","xp":105,"p":"Track lives and end the game when they reach 0.","c":"if lives == 0:\n    game_over()","q":"The game ends when lives ==?","o":["0","1","10"],"a":0,"x":"When lives reaches 0, the game is over."},
  {"e":"💥","t":"Collisions","b":"Did they touch?","lv":"Ages 11+","xp":110,"p":"Check if two things overlap to detect a hit.","c":"if player == enemy_pos:\n    hit()","q":"Two things touching is called a?","o":["collision","recursion","comment"],"a":0,"x":"When two objects overlap it is a collision."},
  {"e":"🕹️","t":"Player Input","b":"Press to move.","lv":"Ages 11+","xp":110,"p":"Games read key presses to move the player.","c":"if key == 'up':\n    y -= 1","q":"Reading the keyboard lets you?","o":["change color","move or act","save a file"],"a":1,"x":"Key input lets the player move or act."},
  {"e":"⏫","t":"Levels","b":"Get harder.","lv":"Ages 11+","xp":110,"p":"Increase difficulty as the player levels up.","c":"if score > 100:\n    level += 1","q":"Levels usually get?","o":["easier","harder","shorter"],"a":1,"x":"Levels usually get harder as you progress."},
  {"e":"⏱️","t":"Timers","b":"Beat the clock.","lv":"Ages 11+","xp":110,"p":"A timer counts down; act when it reaches 0.","c":"if time <= 0:\n    end()","q":"A countdown timer ends at?","o":["0","60","100"],"a":0,"x":"When the timer reaches 0, time is up."},
  {"e":"🏆","t":"Win or Lose","b":"Decide the result.","lv":"Ages 11+","xp":115,"p":"Use conditions to decide win or lose.","c":"if score >= goal:\n    win()","q":"Win/lose is decided by?","o":["conditions","colors","comments"],"a":0,"x":"Conditions (if) decide win or lose."},
  {"e":"🎯","t":"Build: Guessing Game","b":"Your first game!","lv":"Ages 12+","xp":120,"p":"Loop until the player's guess matches the secret number.","c":"while guess != secret:\n    guess = int(input('Guess: '))","q":"Which loop fits 'keep guessing until right'?","o":["for loop","while loop","no loop"],"a":1,"x":"A while loop repeats until the guess is correct."},
 ],
 [  # World 6 · Web Wizard Woods (HTML/CSS, angle brackets escaped)
  {"e":"🏷️","t":"HTML Tags","b":"The web's building blocks.","lv":"Ages 9+","xp":80,"p":"HTML is made of tags inside angle brackets.","c":"&lt;p&gt;Hi&lt;/p&gt;","q":"HTML tags look like?","o":["{tag}","&lt;tag&gt;","(tag)"],"a":1,"x":"HTML tags use angle brackets, like &lt;p&gt;."},
  {"e":"📰","t":"Headings","b":"Big to small.","lv":"Ages 9+","xp":80,"p":"Headings go from &lt;h1&gt; (biggest) down to &lt;h6&gt;.","c":"&lt;h1&gt;Title&lt;/h1&gt;","q":"Which is the biggest heading?","o":["&lt;h6&gt;","&lt;h1&gt;","&lt;big&gt;"],"a":1,"x":"&lt;h1&gt; is the biggest heading; numbers get smaller."},
  {"e":"📄","t":"Paragraphs","b":"Blocks of text.","lv":"Ages 9+","xp":80,"p":"The &lt;p&gt; tag makes a paragraph of text.","c":"&lt;p&gt;Hello world&lt;/p&gt;","q":"Which tag is a paragraph?","o":["&lt;p&gt;","&lt;para&gt;","&lt;text&gt;"],"a":0,"x":"&lt;p&gt; wraps a paragraph."},
  {"e":"🔗","t":"Links","b":"Jump around.","lv":"Ages 10+","xp":85,"p":"The &lt;a href='...'&gt; tag makes a clickable link.","c":"&lt;a href='x.html'&gt;Go&lt;/a&gt;","q":"Which tag makes a link?","o":["&lt;link&gt;","&lt;a&gt;","&lt;url&gt;"],"a":1,"x":"The &lt;a&gt; tag with href makes a link."},
  {"e":"🖼️","t":"Images","b":"Show a picture.","lv":"Ages 10+","xp":85,"p":"The &lt;img src='...'&gt; tag shows a picture.","c":"&lt;img src='cat.png'&gt;","q":"Show an image with?","o":["&lt;img&gt;","&lt;pic&gt;","&lt;image&gt;"],"a":0,"x":"Use &lt;img src='...'&gt; for pictures."},
  {"e":"📋","t":"HTML Lists","b":"Bullet points.","lv":"Ages 10+","xp":85,"p":"A &lt;ul&gt; with &lt;li&gt; items makes a bullet list.","c":"&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;","q":"&lt;li&gt; is a?","o":["list item","link","line"],"a":0,"x":"&lt;li&gt; is one list item inside &lt;ul&gt;."},
  {"e":"🎨","t":"Intro to CSS","b":"Make it pretty.","lv":"Ages 10+","xp":90,"p":"CSS styles how your HTML looks.","c":"p { color: red; }","q":"CSS is used to?","o":["store data","style pages","loop"],"a":1,"x":"CSS controls colors, sizes and layout."},
  {"e":"🌈","t":"CSS Color","b":"Paint with code.","lv":"Ages 10+","xp":90,"p":"The <code>color</code> property sets text color.","c":"h1 { color: blue; }","q":"Which CSS sets text color?","o":["color","paint","text"],"a":0,"x":"The color property sets text color."},
  {"e":"🏷️","t":"CSS Classes","b":"Style many at once.","lv":"Ages 11+","xp":90,"p":"A class styles many elements; use <code>.name</code> in CSS.","c":".big { font-size: 30px; }","q":"A CSS class selector starts with?","o":["#",".","@"],"a":1,"x":"Class selectors start with a dot, like .big."},
  {"e":"🔘","t":"Buttons","b":"Click me!","lv":"Ages 10+","xp":95,"p":"The &lt;button&gt; tag makes a clickable button.","c":"&lt;button&gt;Click&lt;/button&gt;","q":"Which tag is a button?","o":["&lt;btn&gt;","&lt;button&gt;","&lt;click&gt;"],"a":1,"x":"Use the &lt;button&gt; tag."},
 ],
 [  # World 7 · JavaScript Junction
  {"e":"🖥️","t":"console.log","b":"JS printing.","lv":"Ages 11+","xp":95,"p":"<code>console.log()</code> prints in JavaScript.","c":"console.log('hi')","q":"JavaScript prints with?","o":["print()","console.log()","echo"],"a":1,"x":"JavaScript prints with console.log()."},
  {"e":"📦","t":"let & const","b":"JS variables.","lv":"Ages 11+","xp":95,"p":"<code>let</code> makes a changeable variable; <code>const</code> can't change.","c":"let score = 0","q":"Which makes a changeable variable in JS?","o":["let","const","def"],"a":0,"x":"let declares a variable you can change; const cannot."},
  {"e":"🔤","t":"JS Strings","b":"Text in JS.","lv":"Ages 11+","xp":95,"p":"JavaScript strings use quotes too.","c":"let name = 'Sam'","q":"JS strings use?","o":["quotes","brackets","hashes"],"a":0,"x":"Strings use quotes in JS, like 'Sam'."},
  {"e":"✖️","t":"JS Numbers","b":"Math in JS.","lv":"Ages 11+","xp":95,"p":"JavaScript does math just like Python.","c":"console.log(2 * 3)","q":"2 * 3 in JS is?","o":["6","23","'2*3'"],"a":0,"x":"* multiplies: 2 * 3 is 6."},
  {"e":"🤔","t":"JS if","b":"Choices in JS.","lv":"Ages 11+","xp":100,"p":"A JS <code>if</code> puts the condition in <code>( )</code> and code in <code>{ }</code>.","c":"if (x > 5) {\n  win();\n}","q":"JS if conditions go inside?","o":["( )","[ ]","< >"],"a":0,"x":"JS puts the condition in parentheses ( )."},
  {"e":"🛠️","t":"JS Functions","b":"Reuse in JS.","lv":"Ages 11+","xp":100,"p":"The <code>function</code> keyword makes a function in JS.","c":"function hi() {\n  console.log('hi');\n}","q":"JS keyword for a function?","o":["def","function","func"],"a":1,"x":"Use the function keyword in JS."},
  {"e":"📚","t":"JS Arrays","b":"Lists in JS.","lv":"Ages 11+","xp":100,"p":"JavaScript arrays use <code>[ ]</code> like Python lists.","c":"let a = [1, 2, 3]","q":"JS arrays use?","o":["( )","[ ]","{ }"],"a":1,"x":"Arrays use square brackets [ ]."},
  {"e":"🔁","t":"JS for Loop","b":"Repeat in JS.","lv":"Ages 12+","xp":105,"p":"A JS for loop counts with <code>let i</code>.","c":"for (let i=0; i<3; i++) {\n  console.log(i);\n}","q":"What does i++ do?","o":["minus 1 from i","add 1 to i","reset i"],"a":1,"x":"i++ adds 1 to i each loop."},
  {"e":"👆","t":"Click Events","b":"React to clicks.","lv":"Ages 12+","xp":105,"p":"<code>onclick</code> runs code when a button is clicked.","c":"&lt;button onclick='go()'&gt;Go&lt;/button&gt;","q":"onclick runs when?","o":["page loads","the button is clicked","never"],"a":1,"x":"onclick runs when the element is clicked."},
  {"e":"🔔","t":"alert()","b":"Pop a message.","lv":"Ages 11+","xp":105,"p":"<code>alert()</code> shows a popup message in the browser.","c":"alert('Hi!')","q":"alert() shows a?","o":["popup","list","file"],"a":0,"x":"alert() pops up a message box."},
 ],
 [  # World 8 · AI Island
  {"e":"🤖","t":"What is AI?","b":"Smart software.","lv":"Ages 10+","xp":90,"p":"AI is software that learns patterns to make smart guesses.","c":"# AI predicts from data","q":"AI mainly learns from?","o":["patterns in data","magic","luck"],"a":0,"x":"AI learns patterns from data."},
  {"e":"➡️","t":"Input to Output","b":"How AI answers.","lv":"Ages 10+","xp":90,"p":"AI takes an input and produces an output.","c":"# input -> AI -> output","q":"AI turns input into?","o":["output","errors","nothing"],"a":0,"x":"AI maps an input to an output (a prediction)."},
  {"e":"📜","t":"Rule-Based Bots","b":"If, then reply.","lv":"Ages 10+","xp":95,"p":"A rule-based bot uses if-statements to choose a reply.","c":"if msg == 'hi':\n    say('hello')","q":"A rule bot picks replies with?","o":["if statements","colors","images"],"a":0,"x":"Rule-based bots use if-statements."},
  {"e":"🔑","t":"Keywords","b":"Spot the word.","lv":"Ages 10+","xp":95,"p":"Bots look for keywords in your message.","c":"if 'joke' in msg:\n    tell_joke()","q":"Bots scan messages for?","o":["keywords","fonts","pixels"],"a":0,"x":"They search for keywords to pick a reply."},
  {"e":"📚","t":"Training Data","b":"Learn from examples.","lv":"Ages 11+","xp":100,"p":"AI learns from many examples called training data.","c":"# 1000 cat photos","q":"The examples AI learns from are called?","o":["training data","save files","bugs"],"a":0,"x":"The examples AI learns from are training data."},
  {"e":"🧩","t":"Patterns","b":"AI's superpower.","lv":"Ages 11+","xp":100,"p":"AI is great at finding patterns, like which words mean happy.","c":"# happy words -> :)","q":"AI is especially good at finding?","o":["patterns","snacks","sleep"],"a":0,"x":"AI is great at spotting patterns."},
  {"e":"🔮","t":"Predictions","b":"A smart guess.","lv":"Ages 11+","xp":100,"p":"AI makes a best guess (a prediction), not a sure answer.","c":"guess = model(x)","q":"An AI answer is a?","o":["guarantee","prediction","command"],"a":1,"x":"AI gives a prediction - a smart guess."},
  {"e":"⚖️","t":"Fairness & Bias","b":"Good data matters.","lv":"Ages 11+","xp":100,"p":"Bad or unfair data can make AI biased, so good data matters.","c":"# use fair data","q":"Unfair AI usually comes from?","o":["biased data","fast computers","big screens"],"a":0,"x":"Biased data leads to unfair AI."},
  {"e":"📝","t":"Prompts","b":"Tell AI what to do.","lv":"Ages 11+","xp":105,"p":"A prompt is the instruction you give an AI.","c":"prompt = 'write a poem'","q":"A prompt is?","o":["the AI's brain","your instruction","a bug"],"a":1,"x":"A prompt is the request you give the AI."},
  {"e":"🤖","t":"Build: Your Chatbot","b":"Combine the rules.","lv":"Ages 12+","xp":110,"p":"Combine keywords and if-statements to build a chatbot.","c":"if 'bye' in msg:\n    say('see ya!')","q":"To make a rule bot smarter you add more?","o":["if-checks","colors","images"],"a":0,"x":"More if-checks and keywords make a rule bot smarter."},
 ],
 [  # World 9 · Math Mountain
  {"e":"➖","t":"Add & Subtract","b":"The basics.","lv":"Ages 9+","xp":85,"p":"Use <code>+</code> to add and <code>-</code> to subtract.","c":"print(10 - 4)","q":"10 - 4 is?","o":["6","14","4"],"a":0,"x":"Subtraction: 10 - 4 = 6."},
  {"e":"✖️","t":"Multiply & Divide","b":"Bigger math.","lv":"Ages 9+","xp":85,"p":"Use <code>*</code> to multiply and <code>/</code> to divide.","c":"print(12 / 4)","q":"12 / 4 is?","o":["3","8","48"],"a":0,"x":"12 / 4 = 3."},
  {"e":"➗","t":"Modulo (%)","b":"The remainder.","lv":"Ages 10+","xp":90,"p":"<code>%</code> gives the remainder after dividing.","c":"print(7 % 2)","q":"7 % 2 is?","o":["1","3","0"],"a":0,"x":"7 divided by 2 leaves a remainder of 1."},
  {"e":"🔼","t":"Exponents (**)","b":"Powers up.","lv":"Ages 10+","xp":90,"p":"<code>**</code> raises to a power: 2**3 is 2x2x2.","c":"print(2 ** 3)","q":"2 ** 3 is?","o":["6","8","9"],"a":1,"x":"2**3 = 2x2x2 = 8."},
  {"e":"🔢","t":"Ints vs Floats","b":"Whole or decimal.","lv":"Ages 10+","xp":90,"p":"Integers are whole numbers; floats have decimals.","c":"x = 3.5","q":"3.5 is a?","o":["integer","float","string"],"a":1,"x":"Numbers with decimals are floats."},
  {"e":"🔄","t":"Rounding","b":"Nearest whole.","lv":"Ages 10+","xp":90,"p":"<code>round()</code> rounds to the nearest whole number.","c":"print(round(3.7))","q":"round(3.7) is?","o":["3","4","3.7"],"a":1,"x":"3.7 rounds up to 4."},
  {"e":"📊","t":"Averages","b":"Find the middle.","lv":"Ages 11+","xp":95,"p":"Average = the sum divided by how many numbers.","c":"avg = sum(nums) / len(nums)","q":"Average is the sum divided by?","o":["the count","2","the max"],"a":0,"x":"Average = total divided by how many numbers."},
  {"e":"💯","t":"Percentages","b":"Out of 100.","lv":"Ages 11+","xp":95,"p":"A percent is a part out of 100.","c":"part = 50 / 100","q":"50% means 50 out of?","o":["10","100","1000"],"a":1,"x":"Percent means 'per hundred' - out of 100."},
  {"e":"🎲","t":"Dice & Chance","b":"Math of luck.","lv":"Ages 10+","xp":95,"p":"Use random for dice rolls in math games.","c":"import random\nrandom.randint(1,6)","q":"A 6-sided dice gives?","o":["1 to 6","0 to 5","1 to 12"],"a":0,"x":"A standard dice gives 1 to 6."},
  {"e":"📍","t":"Coordinates","b":"X marks the spot.","lv":"Ages 11+","xp":100,"p":"A point on the screen has an x (across) and a y (up/down).","c":"x = 5\ny = 10","q":"Screen position uses?","o":["x and y","only x","colors"],"a":0,"x":"Positions use x (across) and y (up/down)."},
 ],
 [  # World 10 · Master's Summit
  {"e":"📦","t":"Review: Variables","b":"Remember values.","lv":"Ages 11+","xp":120,"p":"Variables remember values so you can use them later.","c":"hp = 100","q":"Variables are used to?","o":["store values","print only","loop"],"a":0,"x":"Variables store values you reuse later."},
  {"e":"🔁","t":"Review: Loops","b":"Repeat smartly.","lv":"Ages 11+","xp":120,"p":"Loops repeat work automatically instead of copy-paste.","c":"for i in range(5):\n    pass","q":"Loops help you?","o":["repeat work","change colors","save files"],"a":0,"x":"Loops repeat actions without copy-paste."},
  {"e":"🛠️","t":"Review: Functions","b":"Reuse steps.","lv":"Ages 11+","xp":120,"p":"Functions group steps you can reuse with a name.","c":"def go():\n    pass","q":"Functions help you?","o":["reuse code","slow down","delete files"],"a":0,"x":"Functions let you reuse steps with a name."},
  {"e":"🎒","t":"Review: Lists","b":"Many values.","lv":"Ages 11+","xp":120,"p":"Lists hold many values together in order.","c":"items = [1, 2, 3]","q":"Lists hold?","o":["one value","many values","no values"],"a":1,"x":"A list holds many values in order."},
  {"e":"🤔","t":"Review: Conditions","b":"Make decisions.","lv":"Ages 11+","xp":120,"p":"Conditions (if) let your code make decisions.","c":"if ok:\n    go()","q":"if statements make?","o":["decisions","lists","loops"],"a":0,"x":"if-statements let code make decisions."},
  {"e":"🖱️","t":"Build: Click Counter","b":"Count clicks.","lv":"Ages 12+","xp":130,"p":"Combine a variable and a button to count clicks.","c":"clicks += 1","q":"A click counter needs a?","o":["variable","image","font"],"a":0,"x":"Store the count in a variable and add 1 per click."},
  {"e":"🧠","t":"Build: Quiz Game","b":"Test your friends.","lv":"Ages 12+","xp":135,"p":"Combine a list of questions, a loop, and a score.","c":"for q in questions:\n    ask(q)","q":"A quiz game tracks your?","o":["score","color","font"],"a":0,"x":"Use a score variable across looped questions."},
  {"e":"📝","t":"Build: To-Do List","b":"Stay organized.","lv":"Ages 12+","xp":135,"p":"Use a list to store and show to-do items.","c":"todos.append('homework')","q":"A to-do app stores tasks in a?","o":["list","number","color"],"a":0,"x":"A list holds your tasks."},
  {"e":"🧮","t":"Build: Calculator","b":"Crunch numbers.","lv":"Ages 12+","xp":140,"p":"Combine input, math and print to make a calculator.","c":"print(a + b)","q":"A calculator mostly uses?","o":["math operators","images","loops only"],"a":0,"x":"It reads numbers and uses math operators."},
  {"e":"🚀","t":"Final Project","b":"Build your own app!","lv":"Ages 12+","xp":150,"p":"Plan, build, test and share your very own app.","c":"# your big idea here","q":"A great step before sharing your app is to?","o":["test it","skip testing","delete it"],"a":0,"x":"Always test your app before you share it."},
 ],
]

def _build_curriculum():
    out, n = [], 0
    for unit, lessons in enumerate(CURRICULUM, start=1):
        for L in lessons:
            n += 1
            steps = [{"h": "Learn", "p": L["p"]}]
            if L.get("c"):
                steps.append({"h": "Try it", "code": L["c"]})
            quiz = {"q": L["q"], "opts": L["o"], "answer": L["a"], "explain": L["x"]}
            out.append({"id": f"l{n}", "emoji": L["e"], "level": L["lv"], "xp": L["xp"],
                        "unit": unit, "title": L["t"], "blurb": L["b"], "steps": steps, "quiz": quiz})
    return out

LESSON_SEED = _build_curriculum()
QUIZ_EXPLAIN = {}


# ────────────────────────────── DB ──────────────────────────────
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL DEFAULT 'kid',
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            parent_email TEXT,
            age_band TEXT,
            age_years INTEGER,
            plan TEXT NOT NULL DEFAULT 'trial',
            trial_ends TEXT,
            family_id INTEGER,
            tokens INTEGER DEFAULT 0,
            avatar TEXT,
            owned_items TEXT,
            link_token TEXT,
            consent_status TEXT DEFAULT 'not_required',
            consent_method TEXT,
            consent_at TEXT,
            consent_by TEXT,
            consent_token TEXT,
            consent_confirm_token TEXT,
            school TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consent_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            child_id INTEGER, child_username TEXT, method TEXT, granted_by TEXT, detail TEXT, created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS notices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, kind TEXT, body TEXT, created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, author_name TEXT, title TEXT, code TEXT,
            shared INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS project_likes (
            user_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, project_id)
        );
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
            author_name TEXT, body TEXT, reported INTEGER DEFAULT 0, created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS takedowns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL, requester_id INTEGER, requester_name TEXT,
            reason TEXT, status TEXT DEFAULT 'pending',
            created_at TEXT, resolved_at TEXT, resolved_by TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            to_email TEXT, kind TEXT, body TEXT, child_id INTEGER,
            link_token TEXT, created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS progress (user_id INTEGER NOT NULL, lesson_id TEXT NOT NULL, completed_at TEXT NOT NULL, PRIMARY KEY (user_id, lesson_id));
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_usage (user_id INTEGER NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
        CREATE TABLE IF NOT EXISTS lessons (
            id TEXT PRIMARY KEY, position INTEGER, emoji TEXT, title TEXT, blurb TEXT,
            level TEXT, xp INTEGER, published INTEGER DEFAULT 1, steps TEXT, quiz TEXT,
            unit INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS unit_tests (
            user_id INTEGER NOT NULL, unit INTEGER NOT NULL,
            passed INTEGER DEFAULT 0, best_score INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0,
            updated_at TEXT, PRIMARY KEY (user_id, unit)
        );
        """
    )
    # Migrate older databases (add any missing user columns) without touching existing rows.
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    add_cols = {
        "age_years": "INTEGER", "consent_status": "TEXT DEFAULT 'not_required'",
        "consent_method": "TEXT", "consent_at": "TEXT", "consent_by": "TEXT",
        "consent_token": "TEXT", "consent_confirm_token": "TEXT", "school": "TEXT",
        "suspended": "INTEGER DEFAULT 0", "suspend_reason": "TEXT", "suspend_until": "TEXT",
        "reset_token": "TEXT", "reset_expires": "TEXT",
    }
    for col, decl in add_cols.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
    conn.commit()
    conn.close()


def seed_settings():
    conn = db()
    row = conn.execute("SELECT value FROM settings WHERE key='plan_settings'").fetchone()
    if not row:
        conn.execute("INSERT INTO settings (key,value) VALUES ('plan_settings',?)", (json.dumps(DEFAULT_PLAN_SETTINGS),))
    conn.commit()
    conn.close()


LESSON_VERSION = "2026-100-lessons-v1"  # bump to refresh the lesson catalog (keeps users & progress)

def seed_lessons():
    conn = db()
    have = conn.execute("SELECT COUNT(*) c FROM lessons").fetchone()["c"]
    ver_row = conn.execute("SELECT value FROM settings WHERE key='lessons_version'").fetchone()
    cur_ver = None
    if ver_row:
        try:
            cur_ver = json.loads(ver_row["value"])
        except (ValueError, TypeError):
            cur_ver = None
    if have == 0 or cur_ver != LESSON_VERSION:
        conn.execute("DELETE FROM lessons")  # refresh catalog; users, progress & accounts are untouched
        for i, l in enumerate(LESSON_SEED):
            conn.execute(
                "INSERT INTO lessons (id,position,emoji,title,blurb,level,xp,published,steps,quiz,unit) VALUES (?,?,?,?,?,?,?,1,?,?,?)",
                (l["id"], i, l["emoji"], l["title"], l["blurb"], l["level"], l["xp"],
                 json.dumps(l["steps"]), json.dumps(l["quiz"]), l.get("unit") or 1),
            )
        conn.execute("INSERT INTO settings (key,value) VALUES ('lessons_version',?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(LESSON_VERSION),))
    conn.commit()
    conn.close()


def get_plan_settings():
    conn = db()
    row = conn.execute("SELECT value FROM settings WHERE key='plan_settings'").fetchone()
    conn.close()
    try:
        return json.loads(row["value"]) if row else dict(DEFAULT_PLAN_SETTINGS)
    except (ValueError, TypeError):
        return dict(DEFAULT_PLAN_SETTINGS)


def get_setting(key, default):
    conn = db()
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    conn.close()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except (ValueError, TypeError):
        return default


def set_setting(key, value):
    conn = db()
    conn.execute("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (key, json.dumps(value)))
    conn.commit()
    conn.close()


def get_pass_percent():
    try:
        return int(get_setting("pass_percent", PASS_PERCENT))
    except (ValueError, TypeError):
        return PASS_PERCENT


def units_passed(user_id):
    conn = db()
    rows = conn.execute("SELECT unit FROM unit_tests WHERE user_id=? AND passed=1 ORDER BY unit", (user_id,)).fetchall()
    conn.close()
    return [r["unit"] for r in rows]


def all_units():
    conn = db()
    rows = conn.execute("SELECT DISTINCT unit FROM lessons WHERE published=1 ORDER BY unit").fetchall()
    conn.close()
    return [r["unit"] for r in rows]


# ────────────────────────────── passwords / time ──────────────────────────────
def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)
    return h.hex(), salt


def verify_password(password, salt, expected_hash):
    h, _ = hash_password(password, salt)
    return secrets.compare_digest(h, expected_hash)


def now_iso():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def today_str():
    return datetime.date.today().isoformat()


# ────────────────────────────── login rate limiting ──────────────────────────────
_login_fails = {}              # key -> list of attempt timestamps
_login_lock = threading.Lock()
LOGIN_MAX_FAILS = 8            # lock out after this many
LOGIN_WINDOW = 600            # ...within this many seconds (10 min)

def too_many_logins(key):
    now = time.time()
    with _login_lock:
        arr = [t for t in _login_fails.get(key, []) if now - t < LOGIN_WINDOW]
        _login_fails[key] = arr
        return len(arr) >= LOGIN_MAX_FAILS

def record_login_fail(key):
    with _login_lock:
        _login_fails.setdefault(key, []).append(time.time())

def clear_login_fails(key):
    with _login_lock:
        _login_fails.pop(key, None)


# Generic anti-spam: limit how often a user can do an action (e.g. post comments).
_action_log = {}               # key -> list of timestamps
_action_lock = threading.Lock()

def rate_limited(key, max_actions, window_seconds):
    """True if `key` has already done `max_actions` within `window_seconds`. Records the attempt otherwise."""
    now = time.time()
    with _action_lock:
        arr = [t for t in _action_log.get(key, []) if now - t < window_seconds]
        if len(arr) >= max_actions:
            _action_log[key] = arr
            return True
        arr.append(now)
        _action_log[key] = arr
        return False


# ────────────────────────────── email ──────────────────────────────
# Two ways to send a real email (otherwise it's a no-op and we just store the in-app message):
#   1. Gmail SMTP  — set GMAIL_APP_PASSWORD (and GMAIL_USER, default coding4kids.support@gmail.com).
#                    This sends straight FROM the Gmail address. Best for a Gmail account.
#   2. Resend API  — set RESEND_API_KEY (needs a verified custom domain for the "from").
EMAIL_FROM_DEFAULT = "Coding4Kids <coding4kids.support@gmail.com>"


def _wrap_html(html):
    return f'<div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">{html}</div>'


def send_email_gmail(to, subject, html):
    user = os.environ.get("GMAIL_USER", "coding4kids.support@gmail.com")
    pw = os.environ.get("GMAIL_APP_PASSWORD")
    if not pw:
        return False
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("EMAIL_FROM", f"Coding4Kids <{user}>")
    msg["To"] = to
    msg.set_content("This email needs an HTML-capable mail app to view.")
    msg.add_alternative(_wrap_html(html), subtype="html")
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ctx, timeout=20) as s:
        s.login(user, pw)
        s.send_message(msg)
    return True


def send_email_resend(to, subject, html):
    key = os.environ.get("RESEND_API_KEY")
    if not key:
        return False
    frm = os.environ.get("EMAIL_FROM", EMAIL_FROM_DEFAULT)
    body = json.dumps({"from": frm, "to": [to], "subject": subject, "html": _wrap_html(html)}).encode()
    req = urllib.request.Request("https://api.resend.com/emails", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=15)
    return True


def send_email(to, subject, html):
    """Send a real email via Gmail SMTP or Resend if configured; otherwise a no-op."""
    if not to:
        return False
    try:
        if send_email_gmail(to, subject, html):
            print(f"email sent (gmail) -> {to}: {subject}")
            return True
        if send_email_resend(to, subject, html):
            print(f"email sent (resend) -> {to}: {subject}")
            return True
        return False  # no provider configured
    except Exception as e:
        print("email send failed:", repr(e))
        return False

def send_email_async(to, subject, html):
    threading.Thread(target=send_email, args=(to, subject, html), daemon=True).start()


def get_super_admin_email():
    """Where moderation alerts go. Set SUPER_ADMIN_EMAIL to override."""
    return os.environ.get("SUPER_ADMIN_EMAIL", "coding4kids.support@gmail.com")


def clean_name(name):
    """Strip angle brackets so a display name can't inject HTML (defense against stored XSS)."""
    return (name or "").replace("<", "").replace(">", "").strip()


def suspension_status(row):
    """Return (active, until_iso). A timed suspension that has passed counts as expired (not active)."""
    if not _row_get(row, "suspended", 0):
        return (False, None)
    until = _row_get(row, "suspend_until")
    if until:
        try:
            ends = datetime.datetime.fromisoformat(until.replace("Z", ""))
            if datetime.datetime.utcnow() >= ends:
                return (False, until)  # time served — expired
        except ValueError:
            pass
    return (True, until)


def clear_suspension(conn, uid):
    conn.execute("UPDATE users SET suspended=0, suspend_reason=NULL, suspend_until=NULL WHERE id=?", (uid,))


# A lightweight first line of defence for kid-posted comments. Manual moderation
# (super admin can remove any comment or delete the account) is the real backstop.
BAD_WORDS = {
    "fuck", "shit", "bitch", "asshole", "bastard", "dick", "piss", "cunt", "slut",
    "whore", "fag", "faggot", "nigger", "nigga", "retard", "rape", "kill yourself",
    "kys", "stupid idiot", "loser", "hate you", "dumbass", "douche", "crap",
    "penis", "vagina", "sex", "porn", "nude",
}


def contains_bad_words(text):
    """True if the text contains a blocked word (case-insensitive, ignores symbols/spacing tricks)."""
    low = (text or "").lower()
    # collapse common letter-substitutions and spacing so "f u c k" / "sh!t" still match
    squashed = re.sub(r"[^a-z]", "", low.replace("@", "a").replace("$", "s").replace("!", "i")
                      .replace("0", "o").replace("1", "i").replace("3", "e").replace("4", "a"))
    for w in BAD_WORDS:
        ww = w.replace(" ", "")
        if ww in squashed or w in low:
            return True
    return False


# ────────────────────────────── COPPA consent ──────────────────────────────
def consent_ok(user):
    """Has this account cleared the parental-consent gate?"""
    if user["role"] != "kid":
        return True
    status = _row_get(user, "consent_status", "not_required")
    return status in ("granted", "not_required")


def log_consent(child_id, child_username, method, granted_by, detail=""):
    conn = db()
    conn.execute(
        "INSERT INTO consent_log (child_id,child_username,method,granted_by,detail,created_at) VALUES (?,?,?,?,?,?)",
        (child_id, child_username, method, granted_by, detail, now_iso()))
    conn.commit()
    conn.close()


def grant_consent(conn, kid_id, method, granted_by):
    conn.execute(
        "UPDATE users SET consent_status='granted', consent_method=?, consent_by=?, consent_at=?, "
        "consent_token=NULL, consent_confirm_token=NULL WHERE id=?",
        (method, granted_by, now_iso(), kid_id))


# ────────────────────────────── admin accounts ──────────────────────────────
def ensure_admin_config():
    defaults = {
        "super_admin_username": "owner", "super_admin_password": secrets.token_urlsafe(12),
        "admin_username": "admin", "admin_password": secrets.token_urlsafe(9),
        "_note": "KEEP THIS FILE PRIVATE. Edit credentials here, then restart the server.",
    }
    cfg = {}
    if os.path.exists(ADMIN_CONFIG):
        with open(ADMIN_CONFIG) as f:
            cfg = json.load(f)
    added = False
    for k, v in defaults.items():
        if k not in cfg:
            cfg[k] = v
            added = True
    # Environment variables (e.g. set in the Render dashboard) override the file — the secure way to set creds in production.
    env_map = {
        "super_admin_username": "SUPER_ADMIN_USER", "super_admin_password": "SUPER_ADMIN_PASS",
        "admin_username": "ADMIN_USER", "admin_password": "ADMIN_PASS",
    }
    for key, env in env_map.items():
        val = os.environ.get(env)
        if val and cfg.get(key) != val:
            cfg[key] = val
            added = True
    if added or not os.path.exists(ADMIN_CONFIG):
        with open(ADMIN_CONFIG, "w") as f:
            json.dump(cfg, f, indent=2)
        print("\n" + "=" * 60)
        print(" ADMIN ACCOUNTS (keep these private)")
        print("   super admin ->", cfg["super_admin_username"], "/", cfg["super_admin_password"])
        print("   admin       ->", cfg["admin_username"], "/", cfg["admin_password"])
        print("=" * 60 + "\n")
    return cfg


def _seed_one(conn, role, username, password, name):
    pwhash, salt = hash_password(password)
    row = conn.execute("SELECT id FROM users WHERE role=? LIMIT 1", (role,)).fetchone()
    if row:
        conn.execute("UPDATE users SET username=?, password_hash=?, salt=? WHERE id=?", (username, pwhash, salt, row["id"]))
    else:
        conn.execute(
            "INSERT INTO users (role,name,username,password_hash,salt,plan,created_at) VALUES (?,?,?,?,?,'pro',?)",
            (role, name, username, pwhash, salt, now_iso()),
        )


def seed_admins():
    cfg = ensure_admin_config()
    conn = db()
    _seed_one(conn, "super_admin", cfg["super_admin_username"].strip(), cfg["super_admin_password"], "Owner")
    _seed_one(conn, "admin", cfg["admin_username"].strip(), cfg["admin_password"], "Admin")
    conn.commit()
    conn.close()


def seed_demo_teacher():
    """A ready-to-use demo teacher account (Teacher Plan, 150 students)."""
    conn = db()
    row = conn.execute("SELECT id FROM users WHERE username='teacherdemo'").fetchone()
    if row:
        conn.close()
        return
    pwhash, salt = hash_password("teachdemo123")
    conn.execute(
        "INSERT INTO users (role,name,username,password_hash,salt,parent_email,plan,school,created_at) "
        "VALUES ('teacher','Demo Teacher','teacherdemo',?,?,?,'teacher','Demo Elementary',?)",
        (pwhash, salt, "coding4kids.support@gmail.com", now_iso()))
    uid = conn.execute("SELECT id FROM users WHERE username='teacherdemo'").fetchone()["id"]
    conn.execute("UPDATE users SET family_id=? WHERE id=?", (uid, uid))  # classroom group = self
    conn.commit()
    conn.close()
    print("  demo teacher -> teacherdemo / teachdemo123 (Teacher Plan)")


SAMPLE_PROJECTS = [
    ("Maya", "Rainbow Stars 🌈", (
        "colors = [\"red\", \"orange\", \"yellow\", \"green\", \"blue\", \"purple\"]\n"
        "for c in colors:\n"
        "    print(c.upper() + \" \" + \"\\u2b50\" * 3)\n"
        "print(\"Have a colorful day!\")\n")),
    ("Leo", "Dice Roller 🎲", (
        "import random\n"
        "print(\"Rolling two dice...\")\n"
        "a = random.randint(1, 6)\n"
        "b = random.randint(1, 6)\n"
        "print(\"You rolled\", a, \"and\", b)\n"
        "print(\"Total:\", a + b)\n"
        "if a == b:\n"
        "    print(\"Doubles! \\U0001f389\")\n")),
    ("Aria", "Times Table 🧮", (
        "number = 7\n"
        "print(\"The\", number, \"times table:\")\n"
        "for i in range(1, 11):\n"
        "    print(number, \"x\", i, \"=\", number * i)\n")),
    ("Sam", "Countdown to Blastoff 🚀", (
        "for n in range(10, 0, -1):\n"
        "    print(n, \"...\")\n"
        "print(\"BLASTOFF! \\U0001f680\")\n")),
    ("Zoe", "FizzBuzz", (
        "for i in range(1, 21):\n"
        "    if i % 15 == 0:\n"
        "        print(\"FizzBuzz\")\n"
        "    elif i % 3 == 0:\n"
        "        print(\"Fizz\")\n"
        "    elif i % 5 == 0:\n"
        "        print(\"Buzz\")\n"
        "    else:\n"
        "        print(i)\n")),
    ("Noah", "Story Maker ✨", (
        "hero = \"a brave robot\"\n"
        "place = \"the candy mountains\"\n"
        "item = \"a glowing key\"\n"
        "print(\"Once upon a time, \" + hero + \" traveled to \" + place + \".\")\n"
        "print(\"There it found \" + item + \" and saved the day!\")\n"
        "print(\"The End. \\U0001f4d6\")\n")),
    ("Ivy", "Even or Odd Checker", (
        "for number in [4, 7, 10, 15, 22]:\n"
        "    if number % 2 == 0:\n"
        "        print(number, \"is even\")\n"
        "    else:\n"
        "        print(number, \"is odd\")\n")),
    ("Max", "ASCII Cat 🐱", (
        "print(\" /\\\\_/\\\\\")\n"
        "print(\"( o.o )\")\n"
        "print(\" > ^ <\")\n"
        "print(\"Meow! I am a cat made of code.\")\n")),
]


def seed_sample_projects():
    """Put a handful of ready-made shared projects in the gallery (once)."""
    if get_setting("samples_seeded", "") == "1":
        return
    conn = db()
    # a showcase account that owns the samples (kid role so they look kid-made)
    row = conn.execute("SELECT id FROM users WHERE username='c4k_showcase'").fetchone()
    if row:
        uid = row["id"]
    else:
        pwhash, salt = hash_password(secrets.token_urlsafe(12))
        conn.execute(
            "INSERT INTO users (role,name,username,password_hash,salt,plan,consent_status,tokens,created_at) "
            "VALUES ('kid','Coding4Kids','c4k_showcase',?,?,'pro','not_required',0,?)",
            (pwhash, salt, now_iso()))
        uid = conn.execute("SELECT id FROM users WHERE username='c4k_showcase'").fetchone()["id"]
    for author, title, code in SAMPLE_PROJECTS:
        conn.execute(
            "INSERT INTO projects (user_id,author_name,title,code,shared,created_at,updated_at) "
            "VALUES (?,?,?,?,1,?,?)", (uid, author, title, code, now_iso(), now_iso()))
    conn.commit()
    conn.close()
    set_setting("samples_seeded", "1")
    print(f"  seeded {len(SAMPLE_PROJECTS)} sample gallery projects")


# ────────────────────────────── user shaping ──────────────────────────────
def trial_days_left(user):
    if user["plan"] != "trial" or not user["trial_ends"]:
        return None
    try:
        ends = datetime.datetime.fromisoformat(user["trial_ends"].replace("Z", ""))
    except ValueError:
        return 0
    delta = ends - datetime.datetime.utcnow()
    return max(0, delta.days + (1 if delta.seconds > 0 else 0))


def effective_plan(user):
    if user["plan"] == "trial":
        left = trial_days_left(user)
        if left is not None and left <= 0:
            return "free"
    return user["plan"]


def plan_cfg(plan):
    return get_plan_settings().get(plan, {"ai": False, "chatsPerDay": 0, "lessonLimit": -1})


def has_ai(user):
    return bool(plan_cfg(effective_plan(user)).get("ai"))


def chats_per_day(user):
    return int(plan_cfg(effective_plan(user)).get("chatsPerDay", 0))


def lesson_limit(user):
    return int(plan_cfg(effective_plan(user)).get("lessonLimit", -1))


def chats_used_today(user_id):
    conn = db()
    row = conn.execute("SELECT count FROM chat_usage WHERE user_id=? AND day=?", (user_id, today_str())).fetchone()
    conn.close()
    return row["count"] if row else 0


def lessons_done_count(user_id):
    conn = db()
    row = conn.execute("SELECT COUNT(*) c FROM progress WHERE user_id=?", (user_id,)).fetchone()
    conn.close()
    return row["c"]


def teacher_plan_cfg(plan):
    return TEACHER_PLANS.get(plan, NO_TEACHER_PLAN)


def students_in_family(family_id):
    if family_id is None:
        return 0
    conn = db()
    row = conn.execute("SELECT COUNT(*) c FROM users WHERE role='kid' AND family_id=?", (family_id,)).fetchone()
    conn.close()
    return row["c"]


def _row_get(row, key, default=None):
    try:
        v = row[key]
        return v if v is not None else default
    except (IndexError, KeyError):
        return default


def public_user(user):
    eff = effective_plan(user)
    up = units_passed(user["id"]) if user["role"] == "kid" else []
    try:
        avatar = json.loads(_row_get(user, "avatar") or "null") or dict(DEFAULT_AVATAR)
    except (ValueError, TypeError):
        avatar = dict(DEFAULT_AVATAR)
    try:
        owned = json.loads(_row_get(user, "owned_items") or "null") or list(FREE_ITEMS)
    except (ValueError, TypeError):
        owned = list(FREE_ITEMS)
    cstatus = _row_get(user, "consent_status", "not_required")
    teacher = {}
    if user["role"] == "teacher":
        tp = teacher_plan_cfg(user["plan"])
        teacher = {"teacherPlan": user["plan"] or "none", "teacherPlanLabel": tp["label"],
                   "studentLimit": tp["students"], "studentsUsed": students_in_family(user["family_id"])}
    return {
        "id": user["id"], "role": user["role"], "name": user["name"], "username": user["username"],
        "plan": user["plan"], "effectivePlan": eff, "trialDaysLeft": trial_days_left(user),
        **teacher,
        "hasAI": has_ai(user), "chatsPerDay": chats_per_day(user), "chatsUsedToday": chats_used_today(user["id"]),
        "lessonLimit": lesson_limit(user), "lessonsDone": lessons_done_count(user["id"]),
        "unitsPassed": up, "level": len(up) + 1,
        "tokens": _row_get(user, "tokens", 0), "avatar": avatar, "ownedItems": owned,
        "linkToken": _row_get(user, "link_token"), "parentEmail": _row_get(user, "parent_email"),
        "ageBand": user["age_band"], "ageYears": _row_get(user, "age_years"), "familyId": user["family_id"],
        "consentStatus": cstatus, "consentMethod": _row_get(user, "consent_method"),
        "needsConsent": (user["role"] == "kid" and cstatus == "pending"),
        "school": _row_get(user, "school"),
        "suspended": bool(_row_get(user, "suspended", 0)),
    }


# ────────────────────────────── auth ──────────────────────────────
def user_from_token(token):
    if not token:
        return None
    conn = db()
    row = conn.execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?", (token,)).fetchone()
    conn.close()
    return row


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    conn = db()
    conn.execute("INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)", (token, user_id, now_iso()))
    conn.commit()
    conn.close()
    return token


USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")


# ────────────────────────────── HTTP handler ──────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "Coding4Kids/2.0"

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode() or "{}")
        except json.JSONDecodeError:
            return {}

    def _token(self):
        auth = self.headers.get("Authorization", "")
        return auth[7:].strip() if auth.startswith("Bearer ") else None

    def _current_user(self):
        return user_from_token(self._token())

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self.handle_api_get(path)
        return self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self.handle_api_post(path)
        self._send_json({"error": "not found"}, 404)

    # ---- GET API ----
    def handle_api_get(self, path):
        if path == "/api/me":
            u = self._current_user()
            return self._send_json({"user": public_user(u)}) if u else self._send_json({"error": "not logged in"}, 401)

        if path == "/api/notices":  # notices the super admin sent to this user
            u = self._current_user()
            if not u:
                return self._send_json({"error": "not logged in"}, 401)
            conn = db()
            rows = conn.execute("SELECT id,kind,body,created_at FROM notices WHERE user_id=? ORDER BY id DESC", (u["id"],)).fetchall()
            conn.close()
            return self._send_json({"notices": [{"id": r["id"], "kind": r["kind"], "body": r["body"],
                                                  "at": (r["created_at"] or "")[:16].replace("T", " ")} for r in rows]})

        if path == "/api/shop":
            u = self._current_user()
            if not u:
                return self._send_json({"error": "not logged in"}, 401)
            pu = public_user(u)
            return self._send_json({"items": SHOP_ITEMS, "owned": pu["ownedItems"], "avatar": pu["avatar"], "tokens": pu["tokens"]})

        if path.startswith("/api/invite/"):  # public: parent looks up the child they're connecting to
            tok = path.rsplit("/", 1)[1]
            conn = db()
            kid = conn.execute("SELECT name, username FROM users WHERE link_token=? AND role='kid'", (tok,)).fetchone()
            conn.close()
            if not kid:
                return self._send_json({"error": "Invite not found"}, 404)
            return self._send_json({"childName": kid["name"], "childUsername": kid["username"]})

        if path == "/api/parent/messages":
            u = self._current_user()
            if not u or u["role"] not in GUARDIAN_ROLES:
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            rows = conn.execute("SELECT * FROM messages WHERE to_email=? ORDER BY id DESC LIMIT 50", (u["parent_email"] or "",)).fetchall()
            conn.close()
            return self._send_json({"messages": [{"kind": r["kind"], "body": r["body"], "createdAt": r["created_at"]} for r in rows]})

        if path == "/api/lessons":  # public: published lessons for the lessons page
            conn = db()
            rows = conn.execute("SELECT * FROM lessons WHERE published=1 ORDER BY position, id").fetchall()
            conn.close()
            return self._send_json({"lessons": [self._lesson_public(r) for r in rows],
                                    "unitNames": UNIT_NAMES, "worlds": WORLDS, "passPercent": get_pass_percent()})

        if path == "/api/progress":
            u = self._current_user()
            if not u:
                return self._send_json({"error": "not logged in"}, 401)
            conn = db()
            rows = conn.execute("SELECT lesson_id FROM progress WHERE user_id=?", (u["id"],)).fetchall()
            tests = conn.execute("SELECT unit,passed,best_score,attempts FROM unit_tests WHERE user_id=?", (u["id"],)).fetchall()
            conn.close()
            return self._send_json({
                "completed": [r["lesson_id"] for r in rows],
                "unitsPassed": units_passed(u["id"]),
                "unitTests": {t["unit"]: {"passed": bool(t["passed"]), "bestScore": t["best_score"], "attempts": t["attempts"]} for t in tests},
                "lessonLimit": lesson_limit(u), "lessonsDone": len(rows),
            })

        if path.startswith("/api/test/"):  # get the question set for a unit (no answers leaked)
            u = self._current_user()
            if not u:
                return self._send_json({"error": "not logged in"}, 401)
            try:
                unit = int(path.rsplit("/", 1)[1])
            except ValueError:
                return self._send_json({"error": "bad unit"}, 400)
            conn = db()
            rows = conn.execute("SELECT * FROM lessons WHERE published=1 AND unit=? ORDER BY position, id", (unit,)).fetchall()
            conn.close()
            questions = []
            for r in rows:
                q = json.loads(r["quiz"] or "{}")
                if q.get("q") and q.get("opts"):
                    questions.append({"lessonId": r["id"], "q": q["q"], "opts": q["opts"]})
            world = WORLDS.get(unit, {})
            return self._send_json({"unit": unit, "unitName": UNIT_NAMES.get(unit, f"Unit {unit}"),
                                    "boss": world.get("boss"), "worldName": world.get("name"),
                                    "questions": questions, "passPercent": get_pass_percent()})

        if path == "/api/parent/family":
            u = self._current_user()
            if not u or u["role"] not in GUARDIAN_ROLES:
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            kids = conn.execute("SELECT * FROM users WHERE role='kid' AND family_id=? ORDER BY id", (u["family_id"],)).fetchall()
            conn.close()
            return self._send_json({"parent": public_user(u), "kids": [public_user(k) for k in kids]})

        if path.startswith("/api/consent/"):  # public: parent opens the consent link
            tok = path.rsplit("/", 1)[1]
            conn = db()
            kid = conn.execute("SELECT id,name,age_years,parent_email FROM users WHERE consent_token=? AND role='kid'", (tok,)).fetchone()
            conn.close()
            if not kid:
                return self._send_json({"error": "This consent link is invalid or already used."}, 404)
            return self._send_json({"childName": kid["name"], "ageYears": kid["age_years"], "parentEmail": kid["parent_email"]})

        if path.startswith("/api/parent/kid-data/"):  # guardian downloads a child's stored data (COPPA review right)
            u = self._current_user()
            if not u or u["role"] not in GUARDIAN_ROLES:
                return self._send_json({"error": "forbidden"}, 403)
            try:
                kid_id = int(path.rsplit("/", 1)[1])
            except ValueError:
                return self._send_json({"error": "bad id"}, 400)
            conn = db()
            kid = conn.execute("SELECT * FROM users WHERE id=? AND role='kid' AND family_id=?", (kid_id, u["family_id"])).fetchone()
            if not kid:
                conn.close()
                return self._send_json({"error": "Not your family's kid."}, 403)
            prog = [r["lesson_id"] for r in conn.execute("SELECT lesson_id FROM progress WHERE user_id=?", (kid_id,)).fetchall()]
            tests = [dict(r) for r in conn.execute("SELECT unit,passed,best_score,attempts FROM unit_tests WHERE user_id=?", (kid_id,)).fetchall()]
            conn.close()
            return self._send_json({"profile": {
                "name": kid["name"], "username": kid["username"], "ageYears": kid["age_years"],
                "parentEmail": kid["parent_email"], "plan": kid["plan"], "tokens": _row_get(kid, "tokens", 0),
                "consentStatus": _row_get(kid, "consent_status"), "consentMethod": _row_get(kid, "consent_method"),
                "consentBy": _row_get(kid, "consent_by"), "consentAt": _row_get(kid, "consent_at"),
                "createdAt": kid["created_at"]}, "lessonsCompleted": prog, "unitTests": tests})

        if path == "/api/admin/users":
            u = self._current_user()
            if not u or u["role"] not in ADMIN_ROLES:
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            rows = conn.execute("SELECT * FROM users WHERE role='kid' ORDER BY id DESC").fetchall()
            conn.close()
            return self._send_json({"users": [public_user(r) | {"createdAt": r["created_at"], "parentEmail": r["parent_email"]} for r in rows]})

        if path == "/api/admin/accounts":  # every registered name (kids + parents), kept forever
            u = self._current_user()
            if not u or u["role"] not in ADMIN_ROLES:
                return self._send_json({"error": "forbidden"}, 403)
            # super admin also sees the regular admin account (so they can log in as it)
            roles = ("kid", "parent", "admin") if u["role"] == "super_admin" else ("kid", "parent")
            placeholders = ",".join("?" for _ in roles)
            conn = db()
            rows = conn.execute(
                f"SELECT id,name,username,role,plan,parent_email,family_id,created_at,suspended,suspend_reason,suspend_until "
                f"FROM users WHERE role IN ({placeholders}) ORDER BY id", roles
            ).fetchall()
            conn.close()
            return self._send_json({"accounts": [
                {"id": r["id"], "name": r["name"], "username": r["username"], "role": r["role"],
                 "plan": r["plan"], "parentEmail": r["parent_email"], "familyId": r["family_id"],
                 "joined": (r["created_at"] or "")[:10],
                 "suspended": suspension_status(r)[0], "suspendReason": _row_get(r, "suspend_reason"),
                 "suspendUntil": _row_get(r, "suspend_until")}
                for r in rows]})

        if path == "/api/admin/stats":
            u = self._current_user()
            if not u or u["role"] not in ADMIN_ROLES:
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            total = conn.execute("SELECT COUNT(*) c FROM users WHERE role='kid'").fetchone()["c"]
            pro = conn.execute("SELECT COUNT(*) c FROM users WHERE role='kid' AND plan IN ('pro','family')").fetchone()["c"]
            trial = conn.execute("SELECT COUNT(*) c FROM users WHERE role='kid' AND plan='trial'").fetchone()["c"]
            parents = conn.execute("SELECT COUNT(*) c FROM users WHERE role='parent'").fetchone()["c"]
            lessons_done = conn.execute("SELECT COUNT(*) c FROM progress").fetchone()["c"]
            conn.close()
            return self._send_json({"totalKids": total, "proKids": pro, "trialKids": trial, "parents": parents, "lessonsCompleted": lessons_done})

        if path == "/api/admin/consent":  # super admin: consent overview + audit log
            u = self._current_user()
            if not u or u["role"] != "super_admin":
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            kids = conn.execute(
                "SELECT id,name,username,age_years,parent_email,consent_status,consent_method,consent_by,consent_at "
                "FROM users WHERE role='kid' ORDER BY id DESC").fetchall()
            log = conn.execute("SELECT child_username,method,granted_by,detail,created_at FROM consent_log ORDER BY id DESC LIMIT 100").fetchall()
            conn.close()
            return self._send_json({
                "kids": [{"id": k["id"], "name": k["name"], "username": k["username"], "ageYears": k["age_years"],
                          "parentEmail": k["parent_email"], "consentStatus": k["consent_status"] or "not_required",
                          "consentMethod": k["consent_method"], "consentBy": k["consent_by"], "consentAt": k["consent_at"]} for k in kids],
                "log": [{"child": r["child_username"], "method": r["method"], "by": r["granted_by"],
                         "detail": r["detail"], "at": (r["created_at"] or "")[:16].replace("T", " ")} for r in log]})

        if path == "/api/admin/settings":  # super admin only: plan settings + all lessons
            u = self._current_user()
            if not u or u["role"] != "super_admin":
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            rows = conn.execute("SELECT * FROM lessons ORDER BY position, id").fetchall()
            conn.close()
            return self._send_json({"planSettings": get_plan_settings(), "passPercent": get_pass_percent(),
                                    "unitNames": UNIT_NAMES, "worlds": WORLDS, "lessons": [self._lesson_public(r) for r in rows]})

        if path == "/api/admin/reported-comments":  # super admin: comments users have flagged
            u = self._current_user()
            if not u or u["role"] != "super_admin":
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            rows = conn.execute(
                "SELECT c.*, p.title AS project_title, p.shared AS project_shared, "
                "us.username AS author_username, us.id AS author_id "
                "FROM comments c "
                "LEFT JOIN projects p ON p.id=c.project_id "
                "LEFT JOIN users us ON us.id=c.user_id "
                "WHERE c.reported > 0 ORDER BY c.reported DESC, c.id DESC").fetchall()
            conn.close()
            return self._send_json({"comments": [{
                "id": r["id"], "body": r["body"], "author": r["author_name"],
                "authorUsername": _row_get(r, "author_username"), "authorId": _row_get(r, "author_id"),
                "projectId": r["project_id"], "projectTitle": _row_get(r, "project_title") or "(deleted project)",
                "reports": r["reported"], "at": (r["created_at"] or "")[:16].replace("T", " ")} for r in rows]})

        if path == "/api/admin/takedowns":  # super admin: pending project takedown requests
            u = self._current_user()
            if not u or u["role"] != "super_admin":
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            rows = conn.execute(
                "SELECT t.*, p.title AS project_title, p.author_name AS project_author, p.shared AS project_shared "
                "FROM takedowns t LEFT JOIN projects p ON p.id=t.project_id "
                "WHERE t.status='pending' ORDER BY t.id DESC").fetchall()
            conn.close()
            return self._send_json({"takedowns": [{
                "id": r["id"], "projectId": r["project_id"],
                "projectTitle": _row_get(r, "project_title") or "(deleted project)",
                "projectAuthor": _row_get(r, "project_author"),
                "projectShared": bool(_row_get(r, "project_shared", 0)),
                "requester": r["requester_name"], "reason": r["reason"],
                "at": (r["created_at"] or "")[:16].replace("T", " ")} for r in rows]})

        if path == "/api/projects/mine":  # the logged-in kid's own saved projects
            u = self._current_user()
            if not u:
                return self._send_json({"error": "not logged in"}, 401)
            conn = db()
            rows = conn.execute(
                "SELECT p.*, (SELECT COUNT(*) FROM project_likes WHERE project_id=p.id) likes "
                "FROM projects p WHERE p.user_id=? ORDER BY p.updated_at DESC", (u["id"],)).fetchall()
            conn.close()
            return self._send_json({"projects": [self._project_public(r) for r in rows]})

        if path == "/api/gallery":  # public-to-logged-in: everyone's shared projects
            u = self._current_user()
            if not u:
                return self._send_json({"error": "not logged in"}, 401)
            conn = db()
            rows = conn.execute(
                "SELECT p.*, (SELECT COUNT(*) FROM project_likes WHERE project_id=p.id) likes, "
                "(SELECT COUNT(*) FROM project_likes WHERE project_id=p.id AND user_id=?) mine "
                "FROM projects p WHERE p.shared=1 ORDER BY likes DESC, p.updated_at DESC LIMIT 200",
                (u["id"],)).fetchall()
            conn.close()
            return self._send_json({
                "canModerate": u["role"] == "super_admin",
                "projects": [self._project_public(r, with_code=True, liked=bool(r["mine"])) for r in rows]})

        if path.startswith("/api/project/"):  # load one project into the playground
            u = self._current_user()
            if not u:
                return self._send_json({"error": "not logged in"}, 401)
            try:
                pid = int(path.rsplit("/", 1)[1])
            except ValueError:
                return self._send_json({"error": "bad id"}, 400)
            conn = db()
            r = conn.execute(
                "SELECT p.*, (SELECT COUNT(*) FROM project_likes WHERE project_id=p.id) likes "
                "FROM projects p WHERE p.id=?", (pid,)).fetchone()
            conn.close()
            if not r:
                return self._send_json({"error": "Project not found"}, 404)
            # you can open your own project, or any shared one (or super admin can open anything)
            if not r["shared"] and r["user_id"] != u["id"] and u["role"] != "super_admin":
                return self._send_json({"error": "This project is private."}, 403)
            return self._send_json({"project": self._project_public(r, with_code=True)})

        if path.startswith("/api/comments/"):  # comments on a shared project
            u = self._current_user()
            if not u:
                return self._send_json({"error": "not logged in"}, 401)
            try:
                pid = int(path.rsplit("/", 1)[1])
            except ValueError:
                return self._send_json({"error": "bad id"}, 400)
            conn = db()
            proj = conn.execute("SELECT user_id, shared FROM projects WHERE id=?", (pid,)).fetchone()
            if not proj or (not proj["shared"] and proj["user_id"] != u["id"] and u["role"] != "super_admin"):
                conn.close()
                return self._send_json({"error": "Project not found"}, 404)
            rows = conn.execute("SELECT * FROM comments WHERE project_id=? ORDER BY id", (pid,)).fetchall()
            conn.close()
            is_mod = u["role"] == "super_admin"
            owns_project = proj["user_id"] == u["id"]
            return self._send_json({"comments": [{
                "id": c["id"], "author": c["author_name"], "body": c["body"],
                "at": (c["created_at"] or "")[:16].replace("T", " "),
                "reported": bool(c["reported"]) if is_mod else False,
                # who is allowed to take this comment down from the UI
                "canDelete": is_mod or owns_project or c["user_id"] == u["id"],
            } for c in rows]})

        return self._send_json({"error": "not found"}, 404)

    def _project_public(self, r, with_code=False, liked=None):
        out = {"id": r["id"], "title": r["title"], "author": r["author_name"],
               "shared": bool(r["shared"]), "likes": _row_get(r, "likes", 0),
               "updatedAt": (r["updated_at"] or "")[:16].replace("T", " ")}
        if with_code:
            out["code"] = r["code"]
        if liked is not None:
            out["liked"] = liked
        return out

    def _lesson_public(self, r):
        quiz = json.loads(r["quiz"] or "{}")
        if quiz and not quiz.get("explain") and r["id"] in QUIZ_EXPLAIN:
            quiz["explain"] = QUIZ_EXPLAIN[r["id"]]
        return {
            "id": r["id"], "position": r["position"], "emoji": r["emoji"], "title": r["title"],
            "blurb": r["blurb"], "level": r["level"], "xp": r["xp"], "published": bool(r["published"]),
            "unit": r["unit"] if r["unit"] is not None else 1,
            "steps": json.loads(r["steps"] or "[]"), "quiz": quiz,
        }

    # ---- POST API ----
    def handle_api_post(self, path):
        data = self._read_json()
        routes = {
            "/api/signup": lambda: self.api_signup(data),
            "/api/parent/signup": lambda: self.api_parent_signup(data),
            "/api/login": lambda: self.api_login(data, allow=("kid", "parent", "teacher", "admin", "super_admin")),
            "/api/admin/login": lambda: self.api_login(data, allow=ADMIN_ROLES),
            "/api/logout": lambda: self.api_logout(),
            "/api/forgot-password": lambda: self.api_forgot_password(data),
            "/api/reset-password": lambda: self.api_reset_password(data),
            "/api/progress": lambda: self.api_progress(data),
            "/api/test/submit": lambda: self.api_test_submit(data),
            "/api/ai": lambda: self.api_ai(data),
            "/api/shop/buy": lambda: self.api_shop_buy(data),
            "/api/avatar": lambda: self.api_save_avatar(data),
            "/api/request-upgrade": lambda: self.api_request_upgrade(data),
            "/api/parent/add-kid": lambda: self.api_parent_add_kid(data),
            "/api/parent/signout-kid": lambda: self.api_parent_signout_kid(data),
            "/api/parent/delete-kid": lambda: self.api_parent_delete_kid(data),
            "/api/teacher/signup": lambda: self.api_teacher_signup(data),
            "/api/consent/start": lambda: self.api_consent_start(data),
            "/api/consent/confirm": lambda: self.api_consent_confirm(data),
            "/api/consent/resend": lambda: self.api_consent_resend(data),
            "/api/checkout": lambda: self.api_checkout(data),
            "/api/admin/set-plan": lambda: self.api_set_plan(data),
            "/api/admin/consent": lambda: self.api_admin_consent(data),
            "/api/admin/notice": lambda: self.api_admin_notice(data),
            "/api/admin/delete-user": lambda: self.api_admin_delete_user(data),
            "/api/admin/suspend": lambda: self.api_admin_suspend(data),
            "/api/notices/dismiss": lambda: self.api_dismiss_notice(data),
            "/api/admin/impersonate": lambda: self.api_impersonate(data),
            "/api/admin/settings": lambda: self.api_save_settings(data),
            "/api/admin/lesson": lambda: self.api_save_lesson(data),
            "/api/admin/lesson/delete": lambda: self.api_delete_lesson(data),
            "/api/projects/save": lambda: self.api_project_save(data),
            "/api/projects/share": lambda: self.api_project_share(data),
            "/api/projects/delete": lambda: self.api_project_delete(data),
            "/api/projects/like": lambda: self.api_project_like(data),
            "/api/comments/add": lambda: self.api_comment_add(data),
            "/api/comments/delete": lambda: self.api_comment_delete(data),
            "/api/comments/report": lambda: self.api_comment_report(data),
            "/api/admin/comment-dismiss": lambda: self.api_admin_comment_dismiss(data),
            "/api/projects/takedown": lambda: self.api_project_takedown(data),
            "/api/admin/takedown-resolve": lambda: self.api_admin_takedown_resolve(data),
        }
        if path in routes:
            return routes[path]()
        return self._send_json({"error": "not found"}, 404)

    def api_logout(self):
        tok = self._token()
        if tok:
            conn = db()
            conn.execute("DELETE FROM sessions WHERE token=?", (tok,))
            conn.commit()
            conn.close()
        return self._send_json({"ok": True})

    def api_forgot_password(self, data):
        """Parent/teacher requests a password-reset link by username or email. Kids reset via their parent."""
        who = (data.get("usernameOrEmail") or "").strip()
        # Always answer the same way so we never reveal which accounts exist.
        generic = {"ok": True, "message": "If an account matches, we've emailed a reset link."}
        if not who or rate_limited(f"forgot:{who.lower()}", 3, 600):
            return self._send_json(generic)
        conn = db()
        row = conn.execute(
            "SELECT * FROM users WHERE (username=? OR parent_email=?) AND role IN ('parent','teacher') LIMIT 1",
            (who, who)).fetchone()
        if row and row["parent_email"]:
            token = secrets.token_urlsafe(24)
            expires = (datetime.datetime.utcnow() + datetime.timedelta(hours=2)).replace(microsecond=0).isoformat() + "Z"
            conn.execute("UPDATE users SET reset_token=?, reset_expires=? WHERE id=?", (token, expires, row["id"]))
            conn.commit()
            url = f"http://localhost:{PORT}/reset.html?token={token}"
            send_email_async(row["parent_email"], "Reset your Coding4Kids password",
                             f"<p>Hi {clean_name(row['name'] or '')}, we got a request to reset your Coding4Kids password.</p>"
                             f"<p><a href=\"{url}\">Click here to choose a new password</a> (link expires in 2 hours).</p>"
                             f"<p style=\"color:#777;font-size:0.9em\">If you didn't ask for this, you can ignore this email — your password won't change.</p>")
        conn.close()
        return self._send_json(generic)

    def api_reset_password(self, data):
        token = (data.get("token") or "").strip()
        password = data.get("password") or ""
        if len(password) < 6:
            return self._send_json({"error": "Password must be at least 6 characters."}, 400)
        conn = db()
        row = conn.execute("SELECT * FROM users WHERE reset_token=?", (token,)).fetchone()
        if not row:
            conn.close()
            return self._send_json({"error": "This reset link is invalid or already used."}, 400)
        exp = _row_get(row, "reset_expires")
        try:
            if not exp or datetime.datetime.utcnow() >= datetime.datetime.fromisoformat(exp.replace("Z", "")):
                conn.close()
                return self._send_json({"error": "This reset link has expired. Please request a new one."}, 400)
        except ValueError:
            conn.close()
            return self._send_json({"error": "This reset link is invalid."}, 400)
        pwhash, salt = hash_password(password)
        conn.execute("UPDATE users SET password_hash=?, salt=?, reset_token=NULL, reset_expires=NULL WHERE id=?",
                     (pwhash, salt, row["id"]))
        conn.execute("DELETE FROM sessions WHERE user_id=?", (row["id"],))  # log out old sessions
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    def api_signup(self, data):
        name = (data.get("name") or "").strip()
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        email = (data.get("parentEmail") or "").strip()
        age_band = (data.get("ageBand") or "").strip()
        try:
            age_years = int(data.get("age")) if data.get("age") not in (None, "") else None
        except (TypeError, ValueError):
            age_years = None
        err = self._validate_credentials(name, username, password)
        if err:
            return self._send_json({"error": err}, 400)
        # COPPA age gate: under 13 needs verifiable parental consent before the account is usable.
        needs_consent = age_years is not None and age_years < COPPA_AGE
        consent_token = secrets.token_urlsafe(10) if needs_consent else None
        consent_status = "pending" if needs_consent else "not_required"
        trial_ends = (datetime.datetime.utcnow() + datetime.timedelta(days=TRIAL_DAYS)).replace(microsecond=0).isoformat() + "Z"
        resp = self._create_user(role="kid", name=name, username=username, password=password,
                                 email=email, age=age_band, age_years=age_years, plan="trial",
                                 trial_ends=trial_ends, consent_status=consent_status,
                                 consent_token=consent_token, return_row=True)
        if not isinstance(resp, tuple):
            return resp  # error already sent (e.g. username taken)
        uid, row = resp
        link_token = row["link_token"]
        invite_url = f"http://localhost:{PORT}/index.html?plink={link_token}"
        # Simulate emails (no SMTP here) by storing messages the parent sees in-app.
        if email:
            invite_body = (f"{name} just joined Coding4Kids! Tap “Sign My Kid and Myself Up” to create your "
                           f"parent account and connect to {name}: {invite_url}")
            conn = db()
            conn.execute("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)",
                         (email, "parent_invite", invite_body, uid, link_token, now_iso()))
            send_email_async(email, f"Connect to {name} on Coding4Kids",
                             f'{invite_body} <a href="{invite_url}">Sign My Kid and Myself Up →</a>')
            if needs_consent:
                consent_url = f"http://localhost:{PORT}/index.html?consent={consent_token}"
                consent_body = (f"Parental consent needed: {name} (under 13) wants to use Coding4Kids. As required by "
                                f"COPPA, please review and approve: {consent_url}")
                conn.execute("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)",
                             (email, "consent_request", consent_body, uid, consent_token, now_iso()))
                send_email_async(email, f"Approve {name}'s Coding4Kids account",
                                 f'{consent_body} <a href="{consent_url}">Review &amp; approve →</a>')
            conn.commit()
            conn.close()
        token = create_session(uid)
        return self._send_json({"token": token, "user": public_user(row),
                                "inviteToken": link_token, "inviteUrl": invite_url, "parentEmail": email,
                                "needsConsent": needs_consent, "consentToken": consent_token})

    def api_parent_signup(self, data):
        name = (data.get("name") or "").strip()
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        email = (data.get("email") or data.get("parentEmail") or "").strip()
        err = self._validate_credentials(name, username, password)
        if err:
            return self._send_json({"error": err}, 400)
        link_token = (data.get("linkToken") or "").strip()
        # Create the parent on the Family plan; family_id = own id (set after insert)
        resp = self._create_user(role="parent", name=name, username=username, password=password,
                                 email=email, age="", plan="family", trial_ends=None, return_row=True)
        if isinstance(resp, tuple):
            uid, row = resp
            linked = None
            conn = db()
            conn.execute("UPDATE users SET family_id=? WHERE id=?", (uid, uid))
            # If they came from a child's invite link, connect that child + grant parental consent.
            linked_id = None
            if link_token:
                kid = conn.execute("SELECT id,name,username FROM users WHERE link_token=? AND role='kid'", (link_token,)).fetchone()
                if kid:
                    conn.execute("UPDATE users SET family_id=?, parent_email=? WHERE id=?", (uid, email, kid["id"]))
                    grant_consent(conn, kid["id"], "parent_account", email)  # a parent creating/linking = consent
                    linked = kid["name"]; linked_id = kid["id"]; linked_username = kid["username"]
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            conn.close()
            if linked_id:
                log_consent(linked_id, linked_username, "parent_account", email, "Parent linked the child's account")
            # Welcome email to the address the parent signed up with (from coding4kids.support@gmail.com).
            if email:
                first = (name.split(" ")[0] or "there")
                link_line = (f" You're now connected to <strong>{clean_name(linked)}</strong>'s account."
                             if linked else "")
                welcome = (f"Hi {clean_name(first)}, welcome to Coding4Kids! 🎉 Your Family account is ready."
                           f"{link_line} From your Family Dashboard you can add kids, see their progress, "
                           f"approve accounts, and sign them in or out anytime. Happy coding!")
                # COPPA: include the parental-consent notice + a written record of consent in the email.
                consent_note = (
                    "Parental Consent (COPPA): As the parent or legal guardian, by creating this Family account "
                    "and adding or linking a child, you give verifiable parental consent for your child(ren) under 13 "
                    "to use Coding4Kids. We collect only what's needed to run the learning service (a first name, "
                    "username, age range, learning progress, and your contact email) — never more than necessary, "
                    "and we never sell it. There is no private messaging; shared projects and comments are moderated. "
                    "You can review or download your child's data, withdraw consent, or delete the account at any time "
                    "from your Family Dashboard or by emailing coding4kids.support@gmail.com.")
                consent_record = ""
                if linked:
                    consent_record = (f"<br><br>Consent recorded: {now_iso()} — you approved {clean_name(linked)}'s account "
                                      f"(method: parent account, granted by {clean_name(email)}).")
                full_body = welcome + "<br><br><strong>Parental Consent (COPPA):</strong> " + \
                    consent_note[len("Parental Consent (COPPA): "):] + consent_record
                conn2 = db()
                conn2.execute("INSERT INTO messages (to_email,kind,body,created_at) VALUES (?,?,?,?)",
                              (email, "welcome", full_body, now_iso()))
                conn2.commit()
                conn2.close()
                dash_url = f"http://localhost:{PORT}/parent.html"
                consent_html = (f'<hr><p style="font-size:0.9em;color:#555"><strong>Parental Consent (COPPA):</strong> '
                                + consent_note[len("Parental Consent (COPPA): "):] + "</p>")
                if consent_record:
                    consent_html += f'<p style="font-size:0.9em;color:#555">{consent_record.strip()}</p>'
                send_email_async(email, "Welcome to Coding4Kids — your account & parental consent 🎉",
                                 f"{welcome}<br><br><a href=\"{dash_url}\">Open your Family Dashboard →</a>{consent_html}")
            token = create_session(uid)
            return self._send_json({"token": token, "user": public_user(row), "linkedChild": linked})
        return resp  # error response already sent

    def _validate_credentials(self, name, username, password):
        if not name or not username or not password:
            return "Name, username and password are required."
        if not USERNAME_RE.match(username):
            return "Username must be 3-20 letters, numbers or underscores."
        if len(password) < 6:
            return "Password must be at least 6 characters."
        return None

    def _create_user(self, role, name, username, password, email, age, plan, trial_ends,
                     family_id=None, return_row=False, age_years=None, consent_status="not_required",
                     consent_method=None, consent_by=None, consent_token=None, school=None):
        name = clean_name(name)          # strip HTML-injection characters from display name
        school = clean_name(school) if school else school
        pwhash, salt = hash_password(password)
        link_token = secrets.token_urlsafe(8)
        avatar = json.dumps(DEFAULT_AVATAR)
        owned = json.dumps(list(FREE_ITEMS))
        conn = db()
        try:
            cur = conn.execute(
                "INSERT INTO users (role,name,username,password_hash,salt,parent_email,age_band,age_years,plan,trial_ends,family_id,"
                "tokens,avatar,owned_items,link_token,consent_status,consent_method,consent_by,consent_token,school,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (role, name, username, pwhash, salt, email, age, age_years, plan, trial_ends, family_id,
                 STARTER_TOKENS, avatar, owned, link_token, consent_status, consent_method, consent_by,
                 consent_token, school, now_iso()),
            )
            conn.commit()
            uid = cur.lastrowid
        except sqlite3.IntegrityError:
            conn.close()
            return self._send_json({"error": "That username is already taken."}, 409)
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        conn.close()
        if return_row:
            return (uid, row)
        token = create_session(uid)
        return self._send_json({"token": token, "user": public_user(row)})

    def api_login(self, data, allow):
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        key = username.lower()
        if too_many_logins(key):
            return self._send_json({"error": "Too many login attempts. Please wait a few minutes and try again."}, 429)
        conn = db()
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        conn.close()
        if not row or not verify_password(password, row["salt"], row["password_hash"]):
            record_login_fail(key)
            return self._send_json({"error": "Wrong username or password."}, 401)
        if row["role"] not in allow:
            return self._send_json({"error": "Those credentials can't be used here."}, 403)
        active, until = suspension_status(row)
        if not active and _row_get(row, "suspended", 0):
            # timed suspension elapsed → auto-reinstate, then let them in
            conn2 = db(); clear_suspension(conn2, row["id"]); conn2.commit(); conn2.close()
        elif active:
            clear_login_fails(key)
            reason = _row_get(row, "suspend_reason") or ""
            msg = "This account has been suspended by an administrator."
            if reason:
                msg += f" Reason: {reason}"
            if until:
                msg += f" It will be reinstated on {until[:16].replace('T', ' ')} UTC."
            else:
                msg += " Please contact coding4kids.support@gmail.com."
            return self._send_json({"error": msg, "suspended": True}, 403)
        clear_login_fails(key)
        token = create_session(row["id"])
        return self._send_json({"token": token, "user": public_user(row)})

    def api_progress(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent must approve this account first.", "consentRequired": True}, 403)
        lesson_id = (data.get("lessonId") or "").strip()
        if not lesson_id:
            return self._send_json({"error": "lessonId required"}, 400)
        conn = db()
        already = conn.execute("SELECT 1 FROM progress WHERE user_id=? AND lesson_id=?", (u["id"], lesson_id)).fetchone()
        done = conn.execute("SELECT COUNT(*) c FROM progress WHERE user_id=?", (u["id"],)).fetchone()["c"]
        limit = lesson_limit(u)
        if not already and limit >= 0 and done >= limit:
            conn.close()
            return self._send_json(
                {"error": f"Your {effective_plan(u)} plan allows {limit} lessons. Upgrade to unlock more!", "limitReached": True}, 403)
        conn.execute("INSERT OR IGNORE INTO progress (user_id,lesson_id,completed_at) VALUES (?,?,?)", (u["id"], lesson_id, now_iso()))
        awarded = 0
        if not already:  # reward tokens for a brand-new completion
            awarded = TOKENS_PER_LESSON
            conn.execute("UPDATE users SET tokens = COALESCE(tokens,0) + ? WHERE id=?", (awarded, u["id"]))
        conn.commit()
        rows = conn.execute("SELECT lesson_id FROM progress WHERE user_id=?", (u["id"],)).fetchall()
        tok = conn.execute("SELECT tokens FROM users WHERE id=?", (u["id"],)).fetchone()["tokens"]
        conn.close()
        return self._send_json({"completed": [r["lesson_id"] for r in rows], "unitsPassed": units_passed(u["id"]),
                                "tokensAwarded": awarded, "tokens": tok})

    def api_test_submit(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent must approve this account first.", "consentRequired": True}, 403)
        try:
            unit = int(data.get("unit"))
        except (TypeError, ValueError):
            return self._send_json({"error": "bad unit"}, 400)
        answers = data.get("answers") or []
        conn = db()
        rows = conn.execute("SELECT * FROM lessons WHERE published=1 AND unit=? ORDER BY position, id", (unit,)).fetchall()
        graded = []  # keep (lesson row, quiz) so we can give "how to fix it" feedback
        for r in rows:
            q = json.loads(r["quiz"] or "{}")
            if q.get("q") and "answer" in q:
                graded.append((r, q))
        total = len(graded)
        if total == 0:
            conn.close()
            return self._send_json({"error": "No test available for this unit."}, 400)
        correct = sum(1 for i, (r, q) in enumerate(graded) if i < len(answers) and answers[i] == q["answer"])
        score = round(correct / total * 100)
        passed_now = score >= get_pass_percent()
        existing = conn.execute("SELECT passed,best_score,attempts FROM unit_tests WHERE user_id=? AND unit=?", (u["id"], unit)).fetchone()
        ever_passed = 1 if (passed_now or (existing and existing["passed"])) else 0
        best = max(score, existing["best_score"]) if existing else score
        attempts = (existing["attempts"] + 1) if existing else 1
        conn.execute(
            "INSERT INTO unit_tests (user_id,unit,passed,best_score,attempts,updated_at) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(user_id,unit) DO UPDATE SET passed=?, best_score=?, attempts=?, updated_at=?",
            (u["id"], unit, ever_passed, best, attempts, now_iso(), ever_passed, best, attempts, now_iso()))
        conn.commit()
        conn.close()
        # Per-question feedback: for wrong answers, tell the kid what to do and how to fix it.
        feedback = []
        for i, (r, q) in enumerate(graded):
            ok = bool(i < len(answers) and answers[i] == q["answer"])
            fb = {"ok": ok, "question": q["q"]}
            if not ok:
                fb["fix"] = q.get("explain") or QUIZ_EXPLAIN.get(r["id"], "Review the lesson and try this question again.")
                fb["review"] = f"{r['emoji']} {r['title']}"
            feedback.append(fb)
        return self._send_json({
            "score": score, "correct": correct, "total": total, "passed": passed_now,
            "passPercent": get_pass_percent(), "results": [f["ok"] for f in feedback], "feedback": feedback,
            "unitsPassed": units_passed(u["id"]), "level": len(units_passed(u["id"])) + 1, "attempts": attempts,
        })

    def api_ai(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "Log in to use the AI buddy.", "locked": True}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent must approve this account first.", "consentRequired": True, "locked": True}, 403)
        if not has_ai(u):
            return self._send_json({"error": "AI features are a Pro perk. Upgrade to unlock Byte!", "locked": True}, 403)
        limit = chats_per_day(u)
        used = chats_used_today(u["id"])
        if limit >= 0 and used >= limit:
            return self._send_json(
                {"error": f"You've used all {limit} AI chats for today. Come back tomorrow! 🌙", "limitReached": True}, 429)
        # record usage
        conn = db()
        conn.execute(
            "INSERT INTO chat_usage (user_id,day,count) VALUES (?,?,1) "
            "ON CONFLICT(user_id,day) DO UPDATE SET count = count + 1",
            (u["id"], today_str()))
        conn.commit()
        conn.close()
        question = (data.get("message") or "").strip()
        remaining = (limit - used - 1) if limit >= 0 else None
        return self._send_json({"reply": byte_reply(question), "remaining": remaining})

    # ── Avatar shop / tokens ──
    def api_shop_buy(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent needs to approve this account first."}, 403)
        item_id = (data.get("itemId") or "").strip()
        item = SHOP_BY_ID.get(item_id)
        if not item:
            return self._send_json({"error": "Unknown item"}, 400)
        pu = public_user(u)
        if item_id in pu["ownedItems"]:
            return self._send_json({"error": "You already own this!"}, 400)
        price = item.get("price", 0)
        if pu["tokens"] < price:
            return self._send_json({"error": f"Not enough tokens — you need {price} 🪙"}, 400)
        owned = pu["ownedItems"] + [item_id]
        conn = db()
        conn.execute("UPDATE users SET tokens = tokens - ?, owned_items=? WHERE id=?", (price, json.dumps(owned), u["id"]))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "tokens": pu["tokens"] - price, "owned": owned})

    def api_save_avatar(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent needs to approve this account first."}, 403)
        av = data.get("avatar") or {}
        pu = public_user(u)
        owned = set(pu["ownedItems"])
        clean = dict(DEFAULT_AVATAR)
        for slot in ("face", "hat", "accessory", "clothing", "companion", "background"):
            val = av.get(slot)
            if val is None:
                clean[slot] = None if slot not in ("face", "background") else clean[slot]
            elif val in owned and SHOP_BY_ID.get(val, {}).get("cat") == slot:
                clean[slot] = val
        conn = db()
        conn.execute("UPDATE users SET avatar=? WHERE id=?", (json.dumps(clean), u["id"]))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "avatar": clean})

    # ── Child asks parent to upgrade (no pricing shown to the kid) ──
    def api_request_upgrade(self, data):
        u = self._current_user()
        if not u or u["role"] != "kid":
            return self._send_json({"error": "Only a kid can ask a parent to upgrade."}, 403)
        if not consent_ok(u):
            return self._send_json({"error": "A parent needs to approve this account first."}, 403)
        parent_email = u["parent_email"]
        body = ("Your kid wants to upgrade. If you would like to upgrade their account, go to "
                "http://localhost:3000/index.html#pricing. If this is a mistake, please ignore "
                "this message. Thank you and have a great day.")
        if parent_email:
            conn = db()
            conn.execute("INSERT INTO messages (to_email,kind,body,child_id,created_at) VALUES (?,?,?,?,?)",
                         (parent_email, "upgrade_request", body, u["id"], now_iso()))
            conn.commit()
            conn.close()
            send_email_async(parent_email, "Your kid wants to upgrade Coding4Kids", body)
        return self._send_json({"ok": True, "parentEmail": parent_email, "message": body})

    def api_parent_add_kid(self, data):
        u = self._current_user()
        if not u or u["role"] not in GUARDIAN_ROLES:
            return self._send_json({"error": "Only a parent or teacher can add kids."}, 403)
        name = (data.get("name") or "").strip()
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        age = (data.get("ageBand") or "").strip()
        err = self._validate_credentials(name, username, password)
        if err:
            return self._send_json({"error": err}, 400)
        # A guardian creating the account *is* the consent: parent_account, or school consent for teachers.
        is_teacher = u["role"] == "teacher"
        if is_teacher:
            cfg = teacher_plan_cfg(u["plan"])
            if students_in_family(u["family_id"]) >= cfg["students"]:
                msg = ("Choose a Teacher or School plan to add students."
                       if cfg["students"] == 0 else
                       f"Your {cfg['label']} allows {cfg['students']} students. Upgrade for more.")
                return self._send_json({"error": msg, "limitReached": True}, 403)
        method = "school" if is_teacher else "parent_account"
        granted_by = (u["school"] + " (teacher: " + u["username"] + ")") if is_teacher else (u["parent_email"] or u["username"])
        resp = self._create_user(role="kid", name=name, username=username, password=password,
                                 email=u["parent_email"], age=age, plan="family", trial_ends=None,
                                 family_id=u["family_id"], consent_status="granted",
                                 consent_method=method, consent_by=granted_by, return_row=True)
        if not isinstance(resp, tuple):
            return resp
        uid, row = resp
        log_consent(uid, username, method, granted_by,
                    "School/classroom consent" if is_teacher else "Parent created the account")
        return self._send_json({"token": None, "user": public_user(row)})

    def api_teacher_signup(self, data):
        name = (data.get("name") or "").strip()
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        school = (data.get("school") or "").strip() or "My Classroom"
        email = (data.get("email") or "").strip()
        err = self._validate_credentials(name, username, password)
        if err:
            return self._send_json({"error": err}, 400)
        resp = self._create_user(role="teacher", name=name, username=username, password=password,
                                 email=email, age="", plan="none", trial_ends=None, school=school, return_row=True)
        if not isinstance(resp, tuple):
            return resp
        uid, row = resp
        conn = db()
        conn.execute("UPDATE users SET family_id=? WHERE id=?", (uid, uid))  # classroom = family group
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        conn.close()
        token = create_session(uid)
        return self._send_json({"token": token, "user": public_user(row)})

    def api_checkout(self, data):
        # NOTE: This does NOT process a real payment and never receives card data.
        # The front-end collects card details only client-side; here we just record
        # a successful "purchase" by upgrading the plan. Swap in a real processor
        # (e.g. Stripe) for production.
        u = self._current_user()
        if not u:
            return self._send_json({"error": "Please log in to upgrade."}, 401)
        plan = (data.get("plan") or "").strip()
        # Teacher/school tiers for educators; Pro/Family for kids & parents.
        if plan in ("teacher", "school"):
            if u["role"] not in ("teacher", "super_admin"):
                return self._send_json({"error": "Only a teacher account can buy this plan."}, 403)
        elif plan in ("pro", "family"):
            if u["role"] not in ("kid", "parent", "super_admin"):
                return self._send_json({"error": "This account type can't purchase a kid plan."}, 403)
        else:
            return self._send_json({"error": "Unknown plan."}, 400)
        conn = db()
        conn.execute("UPDATE users SET plan=? WHERE id=?", (plan, u["id"]))
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
        conn.close()
        return self._send_json({"ok": True, "plan": plan, "user": public_user(row)})

    def api_admin_consent(self, data):
        # Super admin records or revokes parental consent (e.g. for offline consent: phone, paper, in-person).
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        action = (data.get("action") or "").strip()
        conn = db()
        kid = conn.execute("SELECT id,username,parent_email FROM users WHERE id=? AND role='kid'", (data.get("kidId"),)).fetchone()
        if not kid:
            conn.close()
            return self._send_json({"error": "Kid not found."}, 404)
        note = (data.get("note") or "").strip()
        if action == "grant":
            method = (data.get("method") or "admin_recorded").strip()
            granted_by = note or kid["parent_email"] or f"super admin ({admin['username']})"
            grant_consent(conn, kid["id"], method, granted_by)
            conn.commit()
            conn.close()
            log_consent(kid["id"], kid["username"], method, granted_by,
                        f"Recorded by super admin {admin['username']}" + (f": {note}" if note else ""))
            return self._send_json({"ok": True})
        elif action == "revoke":
            new_token = secrets.token_urlsafe(10)
            conn.execute("UPDATE users SET consent_status='pending', consent_method=NULL, consent_by=NULL, "
                         "consent_at=NULL, consent_token=? WHERE id=?", (new_token, kid["id"]))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (kid["id"],))  # also log them out
            conn.commit()
            conn.close()
            log_consent(kid["id"], kid["username"], "revoked", f"super admin ({admin['username']})", note or "Consent revoked")
            return self._send_json({"ok": True})
        return self._send_json({"error": "action must be grant or revoke"}, 400)

    def api_admin_notice(self, data):
        # Super admin sends a notice (with a custom comment) to a user; they see it on their dashboard.
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        msg = (data.get("message") or "").strip()
        if not msg:
            return self._send_json({"error": "Notice message is required."}, 400)
        conn = db()
        target = conn.execute("SELECT id,parent_email FROM users WHERE id=?", (data.get("userId"),)).fetchone()
        if not target:
            conn.close()
            return self._send_json({"error": "User not found."}, 404)
        conn.execute("INSERT INTO notices (user_id,kind,body,created_at) VALUES (?,?,?,?)",
                     (target["id"], (data.get("kind") or "notice"), msg, now_iso()))
        conn.commit()
        conn.close()
        if target["parent_email"]:
            send_email_async(target["parent_email"], "A message from Coding4Kids", msg)
        return self._send_json({"ok": True})

    def api_admin_delete_user(self, data):
        # Super admin deletes an account (kid/parent/teacher) and all its data, with a reason on record.
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        reason = (data.get("reason") or "").strip()
        conn = db()
        target = conn.execute("SELECT * FROM users WHERE id=?", (data.get("userId"),)).fetchone()
        if not target:
            conn.close()
            return self._send_json({"error": "User not found."}, 404)
        if target["role"] in ("admin", "super_admin"):
            conn.close()
            return self._send_json({"error": "Admin accounts can't be deleted here."}, 403)
        uid = target["id"]
        # Keep a record of the deletion + reason (e.g. for the parent on file).
        if target["parent_email"]:
            body = (f"Notice: the Coding4Kids account '{target['name']}' (@{target['username']}) has been deleted by an administrator."
                    + (f" Reason: {reason}" if reason else ""))
            conn.execute("INSERT INTO messages (to_email,kind,body,child_id,created_at) VALUES (?,?,?,?,?)",
                         (target["parent_email"], "account_deleted", body, uid, now_iso()))
            send_email_async(target["parent_email"], "Coding4Kids account deleted", body)
        for sql in ("DELETE FROM progress WHERE user_id=?", "DELETE FROM unit_tests WHERE user_id=?",
                    "DELETE FROM sessions WHERE user_id=?", "DELETE FROM chat_usage WHERE user_id=?",
                    "DELETE FROM notices WHERE user_id=?", "DELETE FROM users WHERE id=?"):
            conn.execute(sql, (uid,))
        conn.commit()
        conn.close()
        log_consent(uid, target["username"], "deleted", f"super admin ({admin['username']})", reason or "Account deleted")
        return self._send_json({"ok": True, "name": target["name"]})

    def api_admin_suspend(self, data):
        # Super admin suspends (or restores) an account. Suspending logs them out and blocks future logins.
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        conn = db()
        target = conn.execute("SELECT * FROM users WHERE id=?", (data.get("userId"),)).fetchone()
        if not target:
            conn.close()
            return self._send_json({"error": "User not found."}, 404)
        if target["role"] in ("admin", "super_admin"):
            conn.close()
            return self._send_json({"error": "Admin accounts can't be suspended here."}, 403)
        suspend = bool(data.get("suspended"))
        reason = (data.get("reason") or "").strip()
        uid = target["id"]
        until = None
        if suspend:
            try:
                days = float(data.get("days") or 0)
            except (TypeError, ValueError):
                days = 0
            if days and days > 0:
                until = (datetime.datetime.utcnow() + datetime.timedelta(days=days)).replace(microsecond=0).isoformat() + "Z"
            conn.execute("UPDATE users SET suspended=1, suspend_reason=?, suspend_until=? WHERE id=?", (reason, until, uid))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))  # force-logout everywhere
        else:
            clear_suspension(conn, uid)
        conn.commit()
        conn.close()
        until_phrase = (f" until {until[:16].replace('T', ' ')} UTC" if until else " indefinitely")
        # Notify the account / parent on file.
        if target["parent_email"]:
            if suspend:
                body = (f"Notice: the Coding4Kids account '{target['name']}' (@{target['username']}) has been "
                        f"suspended by an administrator{until_phrase}." + (f" Reason: {reason}" if reason else "")
                        + " Contact coding4kids.support@gmail.com with questions.")
                subject = "Coding4Kids account suspended"
            else:
                body = (f"Good news: the Coding4Kids account '{target['name']}' (@{target['username']}) has been "
                        f"reinstated and can be used again.")
                subject = "Coding4Kids account reinstated"
            conn2 = db()
            conn2.execute("INSERT INTO messages (to_email,kind,body,child_id,created_at) VALUES (?,?,?,?,?)",
                          (target["parent_email"], "account_suspended" if suspend else "account_reinstated", body, uid, now_iso()))
            conn2.commit()
            conn2.close()
            send_email_async(target["parent_email"], subject, body)
        log_consent(uid, target["username"], "suspended" if suspend else "reinstated",
                    f"super admin ({admin['username']})", (reason + until_phrase) if suspend else "")
        return self._send_json({"ok": True, "name": target["name"], "suspended": suspend, "until": until})

    def api_dismiss_notice(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        conn = db()
        conn.execute("DELETE FROM notices WHERE id=? AND user_id=?", (data.get("id"), u["id"]))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    def api_impersonate(self, data):
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        conn = db()
        target = conn.execute("SELECT * FROM users WHERE id=?", (data.get("userId"),)).fetchone()
        conn.close()
        if not target:
            return self._send_json({"error": "User not found"}, 404)
        if target["role"] == "super_admin":
            return self._send_json({"error": "Cannot impersonate another super admin."}, 403)
        token = create_session(target["id"])  # a real session for the target user
        return self._send_json({"token": token, "user": public_user(target)})

    def api_parent_signout_kid(self, data):
        u = self._current_user()
        if not u or u["role"] not in GUARDIAN_ROLES or u["family_id"] is None:
            return self._send_json({"error": "Only a parent or teacher can do this."}, 403)
        conn = db()
        kid = conn.execute("SELECT id,name FROM users WHERE id=? AND role='kid' AND family_id=?",
                           (data.get("kidId"), u["family_id"])).fetchone()
        if not kid:
            conn.close()
            return self._send_json({"error": "That kid isn't in your family."}, 403)
        conn.execute("DELETE FROM sessions WHERE user_id=?", (kid["id"],))  # ends all their sessions
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "name": kid["name"]})

    def api_parent_delete_kid(self, data):
        u = self._current_user()
        if not u or u["role"] not in GUARDIAN_ROLES or u["family_id"] is None:
            return self._send_json({"error": "Only a parent or teacher can do this."}, 403)
        conn = db()
        kid = conn.execute("SELECT id,name FROM users WHERE id=? AND role='kid' AND family_id=?",
                           (data.get("kidId"), u["family_id"])).fetchone()
        if not kid:
            conn.close()
            return self._send_json({"error": "That kid isn't in your family."}, 403)
        kid_id = kid["id"]
        # COPPA deletion right: erase the child and all their data.
        for sql in ("DELETE FROM progress WHERE user_id=?", "DELETE FROM unit_tests WHERE user_id=?",
                    "DELETE FROM sessions WHERE user_id=?", "DELETE FROM chat_usage WHERE user_id=?",
                    "DELETE FROM messages WHERE child_id=?", "DELETE FROM users WHERE id=?"):
            conn.execute(sql, (kid_id,))
        conn.commit()
        conn.close()
        log_consent(kid_id, kid["name"], "deleted", u["username"], "Guardian deleted the child's account & data")
        return self._send_json({"ok": True, "name": kid["name"]})

    def api_consent_resend(self, data):
        """A locked kid (or first-time setup) sends/re-sends the approval email to their parent."""
        u = self._current_user()
        if not u or u["role"] != "kid":
            return self._send_json({"error": "forbidden"}, 403)
        if consent_ok(u):
            return self._send_json({"error": "This account is already approved."}, 400)
        new_email = (data.get("parentEmail") or "").strip()
        conn = db()
        # update the parent's email if they provided/corrected one
        if new_email:
            conn.execute("UPDATE users SET parent_email=? WHERE id=?", (new_email, u["id"]))
        # make sure there's a consent token to put in the link
        tok = _row_get(u, "consent_token")
        if not tok:
            tok = secrets.token_urlsafe(10)
            conn.execute("UPDATE users SET consent_token=? WHERE id=?", (tok, u["id"]))
        conn.commit()
        kid = conn.execute("SELECT name, parent_email FROM users WHERE id=?", (u["id"],)).fetchone()
        parent_email = kid["parent_email"]
        if not parent_email:
            conn.close()
            return self._send_json({"error": "Please enter a parent's email address."}, 400)
        consent_url = f"http://localhost:{PORT}/index.html?consent={tok}"
        body = (f"Parental consent needed: {kid['name']} (under 13) wants to use Coding4Kids. As required by "
                f"COPPA, please review and approve: {consent_url}")
        conn.execute("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)",
                     (parent_email, "consent_request", body, u["id"], tok, now_iso()))
        conn.commit()
        conn.close()
        send_email_async(parent_email, f"Approve {kid['name']}'s Coding4Kids account",
                         f'{body} <a href="{consent_url}">Review &amp; approve →</a>')
        return self._send_json({"ok": True, "parentEmail": parent_email})

    def api_consent_start(self, data):
        # Email-plus step 1: parent confirms intent; we issue a second confirmation token.
        tok = (data.get("token") or "").strip()
        conn = db()
        kid = conn.execute("SELECT id,name,parent_email FROM users WHERE consent_token=? AND role='kid'", (tok,)).fetchone()
        if not kid:
            conn.close()
            return self._send_json({"error": "Invalid or used consent link."}, 404)
        confirm = secrets.token_urlsafe(10)
        conn.execute("UPDATE users SET consent_confirm_token=? WHERE id=?", (confirm, kid["id"]))
        if kid["parent_email"]:
            confirm_url = f"http://localhost:{PORT}/index.html?consentconfirm={confirm}"
            conn.execute("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)",
                         (kid["parent_email"], "consent_confirm",
                          f"Please confirm consent for {kid['name']} by clicking: {confirm_url}", kid["id"], confirm, now_iso()))
            send_email_async(kid["parent_email"], f"Confirm consent for {kid['name']}",
                             f'One more step to approve {kid["name"]}. <a href="{confirm_url}">Confirm consent →</a>')
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "confirmToken": confirm, "childName": kid["name"]})

    def api_consent_confirm(self, data):
        # Email-plus step 2: the second confirmation actually grants consent.
        tok = (data.get("token") or "").strip()
        conn = db()
        kid = conn.execute("SELECT id,name,username,parent_email FROM users WHERE consent_confirm_token=? AND role='kid'", (tok,)).fetchone()
        if not kid:
            conn.close()
            return self._send_json({"error": "Invalid or used confirmation link."}, 404)
        grant_consent(conn, kid["id"], "email_plus", kid["parent_email"] or "parent")
        conn.commit()
        conn.close()
        log_consent(kid["id"], kid["username"], "email_plus", kid["parent_email"] or "parent",
                    "Parent gave verifiable consent (email-plus)")
        return self._send_json({"ok": True, "childName": kid["name"]})

    def api_set_plan(self, data):
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        plan = (data.get("plan") or "").strip()
        if plan not in ("free", "trial", "pro", "family"):
            return self._send_json({"error": "bad plan"}, 400)
        conn = db()
        conn.execute("UPDATE users SET plan=? WHERE id=? AND role='kid'", (plan, data.get("userId")))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    def api_save_settings(self, data):
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        ps = data.get("planSettings")
        if not isinstance(ps, dict):
            return self._send_json({"error": "planSettings required"}, 400)
        clean = {}
        for plan in ("free", "trial", "pro", "family"):
            p = ps.get(plan, {})
            clean[plan] = {
                "ai": bool(p.get("ai")),
                "chatsPerDay": int(p.get("chatsPerDay", 0)),
                "lessonLimit": int(p.get("lessonLimit", -1)),
            }
        set_setting("plan_settings", clean)
        if "passPercent" in data:
            pp = max(1, min(100, int(data.get("passPercent") or PASS_PERCENT)))
            set_setting("pass_percent", pp)
        return self._send_json({"ok": True, "planSettings": clean, "passPercent": get_pass_percent()})

    def api_save_lesson(self, data):
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        lid = (data.get("id") or "").strip()
        title = (data.get("title") or "").strip()
        if not title:
            return self._send_json({"error": "Title is required."}, 400)
        emoji = (data.get("emoji") or "📘").strip()
        blurb = (data.get("blurb") or "").strip()
        level = (data.get("level") or "All ages").strip()
        xp = int(data.get("xp") or 50)
        published = 1 if data.get("published", True) else 0
        unit = int(data.get("unit") or 1)
        conn = db()
        if lid:
            row = conn.execute("SELECT id FROM lessons WHERE id=?", (lid,)).fetchone()
        else:
            row = None
        if row:  # update metadata only
            conn.execute("UPDATE lessons SET emoji=?,title=?,blurb=?,level=?,xp=?,published=?,unit=? WHERE id=?",
                         (emoji, title, blurb, level, xp, published, unit, lid))
        else:  # create new lesson
            new_id = lid or ("l" + secrets.token_hex(4))
            maxpos = conn.execute("SELECT COALESCE(MAX(position),-1)+1 p FROM lessons").fetchone()["p"]
            default_quiz = {"q": "Did you understand this lesson?", "opts": ["Yes!", "Mostly", "Need to review"], "answer": 0}
            conn.execute("INSERT INTO lessons (id,position,emoji,title,blurb,level,xp,published,steps,quiz,unit) "
                         "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (new_id, maxpos, emoji, title, blurb, level, xp, published,
                          json.dumps([{"h": title, "p": blurb}]), json.dumps(default_quiz), unit))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    def api_delete_lesson(self, data):
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        lid = (data.get("id") or "").strip()
        conn = db()
        conn.execute("DELETE FROM lessons WHERE id=?", (lid,))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    # ---- code playground projects / gallery ----
    PROJECT_MAX = 50          # how many a single kid can keep
    CODE_MAX = 20000          # chars of code per project
    TITLE_MAX = 60

    def api_project_save(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent needs to approve this account first."}, 403)
        title = clean_name(data.get("title") or "")[:self.TITLE_MAX] or "Untitled project"
        code = (data.get("code") or "")[:self.CODE_MAX]
        pid = data.get("id")
        author = clean_name((u["name"] or u["username"] or "").split(" ")[0]) or "A coder"
        conn = db()
        if pid:  # update an existing project the user owns
            row = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (pid, u["id"])).fetchone()
            if not row:
                conn.close()
                return self._send_json({"error": "Project not found"}, 404)
            conn.execute("UPDATE projects SET title=?, code=?, updated_at=? WHERE id=?",
                         (title, code, now_iso(), pid))
        else:  # create new (enforce per-kid cap)
            count = conn.execute("SELECT COUNT(*) c FROM projects WHERE user_id=?", (u["id"],)).fetchone()["c"]
            if count >= self.PROJECT_MAX:
                conn.close()
                return self._send_json({"error": f"You can keep up to {self.PROJECT_MAX} projects. Delete one to save a new one."}, 400)
            cur = conn.execute(
                "INSERT INTO projects (user_id,author_name,title,code,shared,created_at,updated_at) "
                "VALUES (?,?,?,?,0,?,?)", (u["id"], author, title, code, now_iso(), now_iso()))
            pid = cur.lastrowid
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "id": pid})

    def api_project_share(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent needs to approve this account first."}, 403)
        pid = data.get("id")
        shared = 1 if data.get("shared") else 0
        conn = db()
        row = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (pid, u["id"])).fetchone()
        if not row:
            conn.close()
            return self._send_json({"error": "Project not found"}, 404)
        conn.execute("UPDATE projects SET shared=?, updated_at=? WHERE id=?", (shared, now_iso(), pid))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "shared": bool(shared)})

    def api_project_delete(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        pid = data.get("id")
        conn = db()
        if u["role"] == "super_admin":  # moderation: can remove any project
            row = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        else:
            row = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (pid, u["id"])).fetchone()
        if not row:
            conn.close()
            return self._send_json({"error": "Project not found"}, 404)
        conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        conn.execute("DELETE FROM project_likes WHERE project_id=?", (pid,))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    def api_project_like(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        pid = data.get("id")
        conn = db()
        proj = conn.execute("SELECT shared FROM projects WHERE id=?", (pid,)).fetchone()
        if not proj or not proj["shared"]:
            conn.close()
            return self._send_json({"error": "Project not found"}, 404)
        existing = conn.execute("SELECT 1 FROM project_likes WHERE user_id=? AND project_id=?", (u["id"], pid)).fetchone()
        if existing:  # toggle off
            conn.execute("DELETE FROM project_likes WHERE user_id=? AND project_id=?", (u["id"], pid))
            liked = False
        else:
            conn.execute("INSERT INTO project_likes (user_id,project_id) VALUES (?,?)", (u["id"], pid))
            liked = True
        likes = conn.execute("SELECT COUNT(*) c FROM project_likes WHERE project_id=?", (pid,)).fetchone()["c"]
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "liked": liked, "likes": likes})

    COMMENT_MAX = 500

    def api_comment_add(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent needs to approve this account first."}, 403)
        # anti-spam: at most 6 comments per 60s per user
        if rate_limited(f"comment:{u['id']}", 6, 60):
            return self._send_json({"error": "Whoa, slow down a sec! Try again in a moment. 🙂"}, 429)
        pid = data.get("projectId")
        body = clean_name(data.get("body") or "")[:self.COMMENT_MAX]
        if not body:
            return self._send_json({"error": "Write something first!"}, 400)
        if contains_bad_words(body):
            return self._send_json({"error": "Please keep comments kind and clean. That message wasn't posted."}, 400)
        conn = db()
        proj = conn.execute("SELECT shared FROM projects WHERE id=?", (pid,)).fetchone()
        if not proj or not proj["shared"]:
            conn.close()
            return self._send_json({"error": "Project not found"}, 404)
        author = clean_name((u["name"] or u["username"] or "").split(" ")[0]) or "A coder"
        conn.execute("INSERT INTO comments (project_id,user_id,author_name,body,reported,created_at) VALUES (?,?,?,?,0,?)",
                     (pid, u["id"], author, body, now_iso()))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    def api_comment_delete(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        cid = data.get("id")
        conn = db()
        c = conn.execute("SELECT c.*, p.user_id AS owner FROM comments c "
                         "JOIN projects p ON p.id=c.project_id WHERE c.id=?", (cid,)).fetchone()
        if not c:
            conn.close()
            return self._send_json({"error": "Comment not found"}, 404)
        # who can take a comment down: the comment's author, the project owner, or the super admin
        if not (u["role"] == "super_admin" or c["user_id"] == u["id"] or c["owner"] == u["id"]):
            conn.close()
            return self._send_json({"error": "forbidden"}, 403)
        conn.execute("DELETE FROM comments WHERE id=?", (cid,))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    def api_admin_comment_dismiss(self, data):
        """Super admin clears a comment's report flag (keeps the comment)."""
        u = self._current_user()
        if not u or u["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        conn = db()
        c = conn.execute("SELECT id FROM comments WHERE id=?", (data.get("id"),)).fetchone()
        if not c:
            conn.close()
            return self._send_json({"error": "Comment not found"}, 404)
        conn.execute("UPDATE comments SET reported=0 WHERE id=?", (data.get("id"),))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True})

    def api_project_takedown(self, data):
        """Any logged-in user asks for a shared project to be taken down; goes to the super admin."""
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        if not consent_ok(u):
            return self._send_json({"error": "A parent needs to approve this account first."}, 403)
        pid = data.get("projectId")
        reason = clean_name(data.get("reason") or "")[:500]
        conn = db()
        proj = conn.execute("SELECT id,title,author_name,shared FROM projects WHERE id=?", (pid,)).fetchone()
        if not proj or not proj["shared"]:
            conn.close()
            return self._send_json({"error": "Project not found"}, 404)
        # one pending request per user per project (avoid spam)
        dup = conn.execute("SELECT id FROM takedowns WHERE project_id=? AND requester_id=? AND status='pending'",
                           (pid, u["id"])).fetchone()
        if dup:
            conn.close()
            return self._send_json({"ok": True, "already": True})
        requester = clean_name((u["name"] or u["username"] or "").split(" ")[0]) or "A user"
        conn.execute("INSERT INTO takedowns (project_id,requester_id,requester_name,reason,status,created_at) "
                     "VALUES (?,?,?,?,'pending',?)", (pid, u["id"], requester, reason, now_iso()))
        conn.commit()
        conn.close()
        body = (f"<p>A takedown was requested for a gallery project and needs your decision.</p>"
                f"<p><strong>Project:</strong> {html_lib.escape(proj['title'] or '')} "
                f"(by {html_lib.escape(proj['author_name'] or '?')})</p>"
                f"<p><strong>Requested by:</strong> {html_lib.escape(requester)} (@{html_lib.escape(u['username'] or '')})</p>"
                f"<p><strong>Reason:</strong> {html_lib.escape(reason) or '(none given)'}</p>"
                f"<p>Open the Super Admin dashboard → <strong>🛑 Takedown Requests</strong> to approve or deny.</p>")
        send_email_async(get_super_admin_email(), f"Takedown requested: “{(proj['title'] or '')[:40]}”", body)
        return self._send_json({"ok": True})

    def api_admin_takedown_resolve(self, data):
        """Super admin approves (removes the project from the gallery) or denies a takedown request."""
        u = self._current_user()
        if not u or u["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        tid = data.get("id")
        action = (data.get("action") or "").strip()  # 'approve' or 'deny'
        if action not in ("approve", "deny"):
            return self._send_json({"error": "bad action"}, 400)
        conn = db()
        t = conn.execute("SELECT * FROM takedowns WHERE id=?", (tid,)).fetchone()
        if not t:
            conn.close()
            return self._send_json({"error": "Request not found"}, 404)
        if t["status"] != "pending":
            conn.close()
            return self._send_json({"error": "Already resolved."}, 400)
        status = "approved" if action == "approve" else "denied"
        if action == "approve":
            # take the project out of the public gallery (the owner keeps their private copy)
            conn.execute("UPDATE projects SET shared=0 WHERE id=?", (t["project_id"],))
            # any other pending requests for the same project are resolved too
            conn.execute("UPDATE takedowns SET status='approved', resolved_at=?, resolved_by=? "
                         "WHERE project_id=? AND status='pending'", (now_iso(), u["username"], t["project_id"]))
        else:
            conn.execute("UPDATE takedowns SET status='denied', resolved_at=?, resolved_by=? WHERE id=?",
                         (now_iso(), u["username"], tid))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "status": status})

    def api_comment_report(self, data):
        u = self._current_user()
        if not u:
            return self._send_json({"error": "not logged in"}, 401)
        cid = data.get("id")
        conn = db()
        c = conn.execute(
            "SELECT c.*, p.title AS project_title, us.username AS author_username "
            "FROM comments c LEFT JOIN projects p ON p.id=c.project_id "
            "LEFT JOIN users us ON us.id=c.user_id WHERE c.id=?", (cid,)).fetchone()
        if not c:
            conn.close()
            return self._send_json({"error": "Comment not found"}, 404)
        conn.execute("UPDATE comments SET reported=reported+1 WHERE id=?", (cid,))
        conn.commit()
        conn.close()
        # let the super admin know there's something to review — show the actual reported message.
        author = clean_name(c["author_name"] or "") or "?"
        author_un = clean_name(_row_get(c, "author_username") or "")
        project = clean_name(_row_get(c, "project_title") or "(unknown project)")
        reporter = clean_name(u["username"] or "")
        body_html = (
            f"<p>A comment was reported on Coding4Kids and needs review.</p>"
            f"<p><strong>Reported message:</strong></p>"
            f"<blockquote style=\"border-left:3px solid #f59e0b;margin:0;padding:8px 14px;background:#faf6ec;color:#333;\">"
            f"{html_lib.escape(c['body'] or '')}</blockquote>"
            f"<p style=\"color:#555;font-size:0.9em;\">By <strong>{author}</strong> (@{author_un}) · on project “{project}” · reported by @{reporter}</p>"
            f"<p>Open the Super Admin dashboard → <strong>🚩 Reported Comments</strong> to remove it, dismiss the report, or suspend the author.</p>")
        send_email_async(get_super_admin_email(), f"Reported comment: “{(c['body'] or '')[:40]}”", body_html)
        return self._send_json({"ok": True})

    # ---- static files ----
    def _security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")

    def serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        if ".." in path or path.lstrip("/") in ("admin_config.json", "data.db", "server.py"):
            return self._send_json({"error": "forbidden"}, 403)
        fs = os.path.join(ROOT, path.lstrip("/"))
        if not os.path.isfile(fs):
            if os.path.isfile(fs + ".html"):
                fs = fs + ".html"
            else:  # styled 404 page if available
                page = os.path.join(ROOT, "404.html")
                body = open(page, "rb").read() if os.path.isfile(page) else b"404 Not Found"
                self.send_response(404)
                self._security_headers()
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        ext = os.path.splitext(fs)[1]
        with open(fs, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self._security_headers()
        # Long cache for icons/manifest; short for everything else.
        if ext in (".png", ".svg", ".ico"):
            self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(body)


# ────────────────────────────── AI (server side) ──────────────────────────────
def byte_reply(q):
    q = q.lower()
    if re.search(r"variable", q):
        return "A variable is like a labeled box that stores a value! 📦 Example: <code>score = 10</code> puts 10 in a box called <code>score</code>."
    if re.search(r"loop|repeat", q):
        return "A loop repeats code so you don't have to write it 100 times! 🔄 Try: <code>for i in range(3):<br>&nbsp;&nbsp;print('hi')</code>"
    if re.search(r"\bif\b|condition", q):
        return "An <code>if</code> statement makes choices! 🤔 <code>if score > 10:<br>&nbsp;&nbsp;print('You win!')</code> — don't forget the colon!"
    if re.search(r"function", q):
        return "A function is a reusable mini-program! 🛠️ <code>def hello():<br>&nbsp;&nbsp;print('Hi!')</code> — call it with <code>hello()</code>."
    if re.search(r"error|bug|broken|not work", q):
        return "Every coder gets errors! 🐛 Read the last line, check for a missing <code>:</code> or <code>)</code>, and try again. You've got this!"
    if re.search(r"python|javascript|language", q):
        return "Great question! 🐍 Python is super beginner-friendly. You start with blocks, then move to real Python on Coding4Kids!"
    if re.search(r"\b(hi|hello|hey)\b", q):
        return "Hey there, coder! 👋 What do you want to learn today? Loops, variables, functions — just ask!"
    if re.search(r"thank", q):
        return "You're so welcome! 🌟 Keep up the awesome coding — I'm always here to help!"
    return "Ooh, good question! 🤖 I'm best at coding basics — try asking about <code>variables</code>, <code>loops</code>, <code>if statements</code>, or <code>functions</code>!"


def main():
    init_db()
    seed_settings()
    seed_lessons()
    seed_admins()
    seed_demo_teacher()
    seed_sample_projects()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Coding4Kids backend running at http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
