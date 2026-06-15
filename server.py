#!/usr/bin/env python3
"""
KidVibers backend - pure Python standard library (no pip installs needed).

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
import hmac
import secrets
import datetime
import time
import threading
import urllib.request
import urllib.parse
import urllib.error
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

# ── Stripe (real checkout). When STRIPE_SECRET_KEY is unset, checkout stays simulated
# ("you have not been charged") so nothing breaks until you add keys. ──
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
SITE_URL = os.environ.get("SITE_URL", "https://kidvibers.com").rstrip("/")
# Each plan maps to a Stripe Price ID (price_...), provided via env once you create them.
STRIPE_PRICES = {
    "pro":      os.environ.get("STRIPE_PRICE_PRO", ""),
    "family":   os.environ.get("STRIPE_PRICE_FAMILY", ""),
    "teacher":  os.environ.get("STRIPE_PRICE_TEACHER", ""),
    "school":   os.environ.get("STRIPE_PRICE_SCHOOL", ""),
    "district": os.environ.get("STRIPE_PRICE_DISTRICT", ""),
}

TRIAL_DAYS = 3
ADMIN_ROLES = ("admin", "super_admin")
GUARDIAN_ROLES = ("parent", "teacher")   # adults who manage kids
COPPA_AGE = 13                            # under this age, verifiable consent is required (US COPPA)
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
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
    # ── Older-kid / teen track (ages 11-16): deeper, real-world programming ──
    11: {"name": "Function Forge", "emoji": "🛠️", "color": "#8b5cf6",
         "tagline": "Build reusable code like a pro.", "boss": {"name": "Lord Lambda", "emoji": "λ"}},
    12: {"name": "Data Structures Dojo", "emoji": "🥋", "color": "#14b8a6",
         "tagline": "Master lists, dicts, sets & more.", "boss": {"name": "Sensei Nesting", "emoji": "🧩"}},
    13: {"name": "Object Orbit", "emoji": "🪐", "color": "#6366f1",
         "tagline": "Think in objects and classes.", "boss": {"name": "Class Titan", "emoji": "🛰️"}},
    14: {"name": "Pro Coder Peak", "emoji": "⛰️", "color": "#ef4444",
         "tagline": "Errors, recursion & real algorithms.", "boss": {"name": "The Architect", "emoji": "🏛️"}},
    # -- Quiz-recommended bonus tracks (the placement quiz points new coders here) --
    15: {"name": "Spark Lab", "emoji": "🔆", "color": "#fb923c",
         "tagline": "Extra hands-on practice for new coders.", "boss": {"name": "Sparky the Bug", "emoji": "✨"}},
    16: {"name": "Capstone Quests", "emoji": "🏔️", "color": "#3b82f6",
         "tagline": "Real mini-projects for pro coders.", "boss": {"name": "The Final Boss", "emoji": "🐲"}},
}
UNIT_NAMES = {u: f"{w['emoji']} {w['name']}" for u, w in WORLDS.items()}

# Teacher / school subscription tiers (how many students an educator account can have).
# No free tier - a teacher must subscribe to add students.
TEACHER_PLANS = {
    "teacher":   {"label": "Teacher Plan",   "price": 24,  "students": 100},
    "school":    {"label": "School Plan",    "price": 136, "students": 550},
    "district":  {"label": "District Plan",  "price": 150, "students": -1},   # -1 = unlimited
}
NO_TEACHER_PLAN = {"label": "No plan yet", "price": 0, "students": 0}
# Educator plans that unlock the District / Library management dashboard
# (custom branding + suspend / change credentials / delete students).
DISTRICT_PLANS = ("school", "district")

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
 [  # World 11 · Function Forge (ages 11+)
  {"e":"🛠️","t":"Define a Function","b":"Package steps with a name.","lv":"Ages 11+","xp":70,"p":"<code>def</code> creates a function - a named block of code you can run anytime by calling it.","c":"def greet():\n    print('Hi coder!')\n\ngreet()","q":"How do you create a function in Python?","o":["function greet():","def greet():","make greet():"],"a":1,"x":"Use def name(): to define a function."},
  {"e":"📥","t":"Parameters","b":"Send data into a function.","lv":"Ages 11+","xp":70,"p":"A parameter is a variable a function receives. The value you pass in is called an argument.","c":"def greet(name):\n    print('Hi ' + name)\n\ngreet('Sam')","q":"In greet('Sam'), 'Sam' is the?","o":["argument","loop","comment"],"a":0,"x":"The value passed in ('Sam') is the argument; name is the parameter."},
  {"e":"📤","t":"Return Values","b":"Get an answer back.","lv":"Ages 11+","xp":75,"p":"<code>return</code> sends a value back to whoever called the function so you can use it.","c":"def add(a, b):\n    return a + b\n\nprint(add(2, 3))","q":"What does return do?","o":["prints text","sends a value back","stops Python"],"a":1,"x":"return hands a value back to the caller."},
  {"e":"🔢","t":"Multiple Parameters","b":"More than one input.","lv":"Ages 11+","xp":75,"p":"Functions can take several parameters separated by commas.","c":"def area(w, h):\n    return w * h\n\nprint(area(4, 5))","q":"How many arguments does area(4, 5) receive?","o":["1","2","5"],"a":1,"x":"Two values are passed: w=4 and h=5."},
  {"e":"🎚️","t":"Default Parameters","b":"Optional inputs.","lv":"Ages 12+","xp":80,"p":"A default value is used when no argument is given for that parameter.","c":"def greet(name='friend'):\n    print('Hi ' + name)\n\ngreet()","q":"greet() with no argument prints?","o":["Hi friend","an error","Hi name"],"a":0,"x":"With no argument, name uses its default 'friend'."},
  {"e":"🏷️","t":"Keyword Arguments","b":"Name your inputs.","lv":"Ages 12+","xp":80,"p":"You can pass arguments by name, in any order.","c":"def box(w, h):\n    return w * h\n\nprint(box(h=2, w=3))","q":"box(h=2, w=3) works because the arguments are?","o":["in the right order only","named (keyword args)","random"],"a":1,"x":"Naming arguments lets you pass them in any order."},
  {"e":"🔭","t":"Variable Scope","b":"Where variables live.","lv":"Ages 12+","xp":85,"p":"A variable made inside a function is <em>local</em> - it only exists inside that function.","c":"def f():\n    x = 5\n    print(x)\n\nf()","q":"A variable created inside a function is?","o":["global everywhere","local to that function","deleted instantly"],"a":1,"x":"Variables defined inside a function are local to it."},
  {"e":"📦","t":"Return Multiple Values","b":"Hand back a pack.","lv":"Ages 12+","xp":85,"p":"A function can return several values at once, separated by commas, and you can unpack them.","c":"def stats(a, b):\n    return a + b, a * b\n\ns, p = stats(2, 3)\nprint(s, p)","q":"return a, b hands back a?","o":["single number","pair of values","string"],"a":1,"x":"It returns both values (a tuple) you can unpack into s and p."},
  {"e":"λ","t":"Lambda Functions","b":"Tiny one-line functions.","lv":"Ages 13+","xp":90,"p":"A <code>lambda</code> is a small function written in a single line.","c":"square = lambda n: n * n\nprint(square(6))","q":"A lambda is a?","o":["loop","short anonymous function","list"],"a":1,"x":"lambda makes a small one-line function without def."},
 ],
 [  # World 12 · Data Structures Dojo (ages 12+)
  {"e":"🔎","t":"Index & Slice Lists","b":"Grab items by position.","lv":"Ages 11+","xp":75,"p":"List positions start at 0. Use <code>[start:end]</code> to slice out a piece.","c":"nums = [10, 20, 30, 40]\nprint(nums[0])\nprint(nums[1:3])","q":"nums[0] gives the?","o":["first item","last item","whole list"],"a":0,"x":"Indexes start at 0, so nums[0] is the first item."},
  {"e":"🧰","t":"List Methods","b":"Add, remove, sort.","lv":"Ages 11+","xp":75,"p":"Lists have tools: <code>append</code> adds, <code>pop</code> removes, <code>sort</code> orders.","c":"nums = [3, 1, 2]\nnums.append(4)\nnums.sort()\nprint(nums)","q":"Which method adds an item to the end?","o":["append","pop","len"],"a":0,"x":"append() adds an item to the end of a list."},
  {"e":"🔢","t":"Loop with enumerate","b":"Item plus its position.","lv":"Ages 12+","xp":80,"p":"<code>enumerate</code> gives you the index and the item together while looping.","c":"for i, item in enumerate(['a', 'b']):\n    print(i, item)","q":"enumerate gives you?","o":["only items","index and item","only numbers"],"a":1,"x":"enumerate yields the position and the item each loop."},
  {"e":"🗂️","t":"Dictionaries","b":"Key-value pairs.","lv":"Ages 12+","xp":80,"p":"A dictionary stores values under named keys instead of positions.","c":"player = {'name': 'Sam', 'hp': 100}\nprint(player['hp'])","q":"You look up a dictionary value using its?","o":["index number","key","color"],"a":1,"x":"Dictionaries are accessed by key, like player['hp']."},
  {"e":"🔑","t":"Dict Keys & Values","b":"Tour the data.","lv":"Ages 12+","xp":85,"p":"<code>.keys()</code>, <code>.values()</code> and <code>.items()</code> let you loop through a dictionary.","c":"d = {'a': 1, 'b': 2}\nfor k, v in d.items():\n    print(k, v)","q":"d.items() gives back?","o":["only keys","key-value pairs","a number"],"a":1,"x":".items() gives each key together with its value."},
  {"e":"📌","t":"Tuples","b":"Locked-down lists.","lv":"Ages 12+","xp":85,"p":"A tuple is like a list, but it cannot be changed (it's immutable).","c":"point = (3, 4)\nprint(point[0])","q":"A tuple is different from a list because it?","o":["can't be changed","holds one value","prints faster"],"a":0,"x":"Tuples are immutable - their contents can't be changed."},
  {"e":"🎯","t":"Sets","b":"No duplicates allowed.","lv":"Ages 13+","xp":85,"p":"A <code>set</code> stores only unique items - duplicates are removed automatically.","c":"nums = {1, 2, 2, 3}\nprint(nums)","q":"A set automatically removes?","o":["duplicates","all items","numbers"],"a":0,"x":"Sets keep only unique values, dropping duplicates."},
  {"e":"🪆","t":"Nested Data","b":"Lists inside dicts.","lv":"Ages 13+","xp":90,"p":"You can nest structures - like a list of dictionaries - to model real-world data.","c":"team = [{'n': 'Sam'}, {'n': 'Mia'}]\nprint(team[1]['n'])","q":"team[1]['n'] reads?","o":["the first name","the second person's name","an error"],"a":1,"x":"team[1] is the 2nd dict; ['n'] reads its name → 'Mia'."},
  {"e":"✨","t":"List Comprehensions","b":"Build lists in one line.","lv":"Ages 13+","xp":95,"p":"A comprehension builds a whole list in a single compact line.","c":"squares = [n * n for n in range(5)]\nprint(squares)","q":"[n*n for n in range(5)] builds a?","o":["list of squares","single number","dictionary"],"a":0,"x":"It builds a new list with each n squared."},
 ],
 [  # World 13 · Object Orbit (ages 12+, OOP)
  {"e":"🧱","t":"Objects & Classes","b":"Blueprints for things.","lv":"Ages 12+","xp":85,"p":"A <code>class</code> is a blueprint; an <em>object</em> is a real thing built from it.","c":"class Dog:\n    pass\n\nrex = Dog()\nprint(rex)","q":"A class is best described as a?","o":["blueprint","loop","list"],"a":0,"x":"A class is a blueprint; objects are made from it."},
  {"e":"🏗️","t":"The __init__ Method","b":"Set up new objects.","lv":"Ages 13+","xp":90,"p":"<code>__init__</code> runs automatically when an object is created, setting its starting values.","c":"class Dog:\n    def __init__(self, name):\n        self.name = name\n\nd = Dog('Rex')\nprint(d.name)","q":"__init__ runs when you?","o":["create an object","print something","start a loop"],"a":0,"x":"__init__ runs automatically when a new object is created."},
  {"e":"🪞","t":"Understanding self","b":"The object itself.","lv":"Ages 13+","xp":90,"p":"<code>self</code> refers to the specific object, so each one keeps its own data.","c":"class Cat:\n    def __init__(self, n):\n        self.n = n\n\nc = Cat('Mia')\nprint(c.n)","q":"self refers to?","o":["the class file","the specific object","a loop"],"a":1,"x":"self is the current object, holding its own attributes."},
  {"e":"🎨","t":"Attributes","b":"Data stored on an object.","lv":"Ages 13+","xp":90,"p":"Attributes are variables that belong to an object, like <code>self.hp</code>.","c":"class Hero:\n    def __init__(self):\n        self.hp = 100\n\nh = Hero()\nprint(h.hp)","q":"self.hp = 100 creates an?","o":["attribute","function","loop"],"a":0,"x":"Values stored on the object (self.hp) are attributes."},
  {"e":"⚙️","t":"Methods","b":"Actions an object can do.","lv":"Ages 13+","xp":95,"p":"A method is a function that belongs to a class.","c":"class Dog:\n    def bark(self):\n        print('Woof!')\n\nDog().bark()","q":"A method is a function that?","o":["belongs to a class","has no name","never runs"],"a":0,"x":"Methods are functions defined inside a class."},
  {"e":"👥","t":"Many Objects","b":"One class, many things.","lv":"Ages 13+","xp":95,"p":"From one class you can create many separate objects, each with its own data.","c":"class P:\n    def __init__(self, n):\n        self.n = n\n\na = P('Sam')\nb = P('Mia')\nprint(a.n, b.n)","q":"a and b made from class P are?","o":["the same object","separate objects","functions"],"a":1,"x":"Each call to P(...) makes a new, separate object."},
  {"e":"🛡️","t":"Methods Using Data","b":"Combine data and actions.","lv":"Ages 14+","xp":100,"p":"Methods can read and change the object's own attributes through self.","c":"class Hero:\n    def __init__(self):\n        self.hp = 100\n    def hurt(self, n):\n        self.hp = self.hp - n\n\nh = Hero()\nh.hurt(30)\nprint(h.hp)","q":"h.hurt(30) changes the object's?","o":["class name","hp attribute","color"],"a":1,"x":"The method updates self.hp, the object's own data."},
  {"e":"🧬","t":"Inheritance","b":"Build on another class.","lv":"Ages 14+","xp":100,"p":"A class can <em>inherit</em> from another, reusing its methods.","c":"class Animal:\n    def eat(self):\n        print('nom')\n\nclass Dog(Animal):\n    pass\n\nDog().eat()","q":"class Dog(Animal) means Dog?","o":["inherits from Animal","deletes Animal","ignores Animal"],"a":0,"x":"Dog(Animal) makes Dog inherit Animal's methods."},
  {"e":"🪐","t":"Build: A Class","b":"Model something real.","lv":"Ages 14+","xp":110,"p":"Combine __init__, attributes and methods to model a real thing - like a bank account.","c":"class Account:\n    def __init__(self):\n        self.bal = 0\n    def add(self, n):\n        self.bal = self.bal + n\n\na = Account()\na.add(50)\nprint(a.bal)","q":"A good class bundles together?","o":["data and actions","only numbers","only loops"],"a":0,"x":"Classes bundle related data (attributes) and actions (methods)."},
 ],
 [  # World 14 · Pro Coder Peak (ages 13+, advanced)
  {"e":"🧯","t":"Handle Errors","b":"Catch problems safely.","lv":"Ages 13+","xp":95,"p":"<code>try/except</code> lets your program handle an error instead of crashing.","c":"try:\n    print(10 / 0)\nexcept:\n    print('Cannot divide by zero')","q":"try/except is used to?","o":["handle errors","make loops","define classes"],"a":0,"x":"try/except catches errors so the program keeps running."},
  {"e":"🚨","t":"Raise an Error","b":"Signal a problem on purpose.","lv":"Ages 14+","xp":95,"p":"<code>raise</code> deliberately triggers an error when something is wrong.","c":"def withdraw(n):\n    if n < 0:\n        raise ValueError('negative!')\n    return n\n\nprint(withdraw(5))","q":"raise is used to?","o":["trigger an error on purpose","ignore all errors","make a loop"],"a":0,"x":"raise deliberately throws an error you choose."},
  {"e":"🌀","t":"Recursion","b":"A function that calls itself.","lv":"Ages 14+","xp":100,"p":"A recursive function calls itself, with a <em>base case</em> that stops it.","c":"def countdown(n):\n    if n == 0:\n        return\n    print(n)\n    countdown(n - 1)\n\ncountdown(3)","q":"A recursion's base case is there to?","o":["stop the calls","speed it up","print colors"],"a":0,"x":"The base case stops a recursive function from running forever."},
  {"e":"❗","t":"Recursion: Factorial","b":"The classic example.","lv":"Ages 14+","xp":105,"p":"Factorial multiplies n by every number below it - a perfect recursion example.","c":"def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\n\nprint(fact(5))","q":"fact(5) returns?","o":["15","120","5"],"a":1,"x":"5*4*3*2*1 = 120."},
  {"e":"🔍","t":"Linear Search","b":"Check each item.","lv":"Ages 14+","xp":105,"p":"Linear search looks at each item one by one until it finds the target.","c":"def find(lst, t):\n    for i in range(len(lst)):\n        if lst[i] == t:\n            return i\n    return -1\n\nprint(find([5, 8, 2], 2))","q":"Linear search checks items?","o":["one by one","all at once","randomly"],"a":0,"x":"It scans each item in order until it finds the target."},
  {"e":"⚡","t":"Binary Search","b":"Divide and conquer.","lv":"Ages 15+","xp":110,"p":"On a <em>sorted</em> list, binary search checks the middle and throws away half each time - very fast.","c":"nums = [1, 3, 5, 7, 9]\nmid = len(nums) // 2\nprint(nums[mid])","q":"Binary search needs the list to be?","o":["sorted","empty","reversed"],"a":0,"x":"Binary search only works on a sorted list."},
  {"e":"🫧","t":"Bubble Sort","b":"Swap until sorted.","lv":"Ages 15+","xp":110,"p":"Bubble sort repeatedly swaps neighbouring items that are out of order.","c":"nums = [3, 1, 2]\nfor i in range(len(nums)):\n    for j in range(len(nums) - 1):\n        if nums[j] > nums[j + 1]:\n            nums[j], nums[j + 1] = nums[j + 1], nums[j]\nprint(nums)","q":"Bubble sort works by?","o":["swapping neighbours","deleting items","adding items"],"a":0,"x":"It swaps neighbouring items until the list is sorted."},
  {"e":"📚","t":"Modules & import","b":"Use Python's toolboxes.","lv":"Ages 13+","xp":100,"p":"<code>import</code> brings in extra tools, like the math and random modules.","c":"import math\nprint(math.sqrt(16))","q":"import lets you?","o":["use extra modules","delete code","make loops"],"a":0,"x":"import loads modules full of ready-made tools."},
  {"e":"🧾","t":"Structured Data","b":"How real apps store info.","lv":"Ages 15+","xp":115,"p":"Real apps store data as nested dictionaries and lists - the idea behind JSON.","c":"user = {'name': 'Sam', 'scores': [8, 9, 10]}\nprint(user['scores'][2])","q":"Nested dicts and lists are how apps?","o":["organize data","change colors","loop forever"],"a":0,"x":"Structured data (dicts + lists) is how apps model real information."},
 ],
 [  # World 15 · Spark Lab (beginner reinforcement - the quiz sends brand-new coders here)
  {"e":"🎨","t":"Emoji Art","b":"Print a picture with code.","lv":"Ages 7+","xp":45,"p":"You can use <code>print</code> many times to draw simple art.","c":"print('  *  ')\nprint(' *** ')\nprint('*****')","q":"How many lines do 3 prints show?","o":["1","3","5"],"a":1,"x":"Each print() makes its own line, so 3 prints show 3 lines."},
  {"e":"👋","t":"Name Greeter","b":"Say hi to anyone.","lv":"Ages 7+","xp":50,"p":"Store the user's name in a variable, then use it.","c":"name = input('Your name? ')\nprint('Hi ' + name + '!')","q":"How do you join two strings?","o":["with +","with -","with *"],"a":0,"x":"The + sign joins (concatenates) strings together."},
  {"e":"🔢","t":"Simple Counter","b":"Count out loud with a loop.","lv":"Ages 8+","xp":50,"p":"<code>range(1, 6)</code> gives the numbers 1, 2, 3, 4, 5.","c":"for n in range(1, 6):\n    print(n)","q":"What is the last number range(1, 6) prints?","o":["6","5","4"],"a":1,"x":"range stops BEFORE the second number, so it ends at 5."},
  {"e":"⚖️","t":"Even or Odd","b":"Is it even?","lv":"Ages 9+","xp":55,"p":"The <code>%</code> sign gives the remainder. An even number has remainder 0 when divided by 2.","c":"n = 4\nif n % 2 == 0:\n    print('even')\nelse:\n    print('odd')","q":"What is 4 % 2?","o":["0","1","2"],"a":0,"x":"4 divides by 2 evenly, so the remainder is 0."},
  {"e":"🔐","t":"Secret Password","b":"Check a code word.","lv":"Ages 9+","xp":55,"p":"Use <code>==</code> to check if what the user typed matches.","c":"pw = input('Password? ')\nif pw == 'pizza':\n    print('Access granted!')\nelse:\n    print('Wrong!')","q":"Which checks if two things are equal?","o":["=","==","=>"],"a":1,"x":"== compares; a single = stores a value."},
  {"e":"⭐","t":"Star Builder","b":"Build a line of stars.","lv":"Ages 9+","xp":55,"p":"You can add to a string inside a loop to make it grow.","c":"stars = ''\nfor i in range(5):\n    stars = stars + '*'\nprint(stars)","q":"What does this print?","o":["*****","5","* * * * *"],"a":0,"x":"The loop adds a star 5 times, making *****."},
  {"e":"🧮","t":"Mini Calculator","b":"Add two numbers.","lv":"Ages 9+","xp":60,"p":"<code>int()</code> turns typed text into a number you can add.","c":"a = int(input('First: '))\nb = int(input('Second: '))\nprint(a + b)","q":"Why use int() on input?","o":["to make it text","to turn text into a number","to delete it"],"a":1,"x":"input() gives text; int() turns it into a number for math."},
  {"e":"🎲","t":"Lucky Number","b":"Roll a random number.","lv":"Ages 9+","xp":60,"p":"<code>random.randint(1, 6)</code> picks a random number like a dice.","c":"import random\nprint(random.randint(1, 6))","q":"randint(1, 6) can give?","o":["only 1","any number 1 to 6","7"],"a":1,"x":"randint(1, 6) returns a random whole number from 1 to 6."},
 ],
 [  # World 16 · Capstone Quests (advanced mini-projects - the quiz sends experienced coders here)
  {"e":"📝","t":"Build a To-Do List","b":"Add tasks to a list.","lv":"Ages 13+","xp":95,"p":"Use <code>.append()</code> to add items to a list.","c":"todo = []\ntodo.append('Code')\ntodo.append('Play')\nprint(todo)","q":"What does .append() do?","o":["adds an item","removes all items","sorts numbers"],"a":0,"x":".append() adds a new item to the end of a list."},
  {"e":"🔤","t":"Word Counter","b":"Count words in a sentence.","lv":"Ages 13+","xp":100,"p":"<code>.split()</code> breaks a sentence into a list of words; <code>len()</code> counts them.","c":"text = 'i love to code'\nwords = text.split()\nprint(len(words))","q":"What does this print?","o":["4","1","'i love to code'"],"a":0,"x":"split() makes 4 words and len() counts them: 4."},
  {"e":"🎯","t":"Guessing Game","b":"Guess the secret number.","lv":"Ages 13+","xp":105,"p":"A <code>while</code> loop keeps asking until the guess is right.","c":"secret = 7\nguess = 0\nwhile guess != secret:\n    guess = int(input('Guess: '))\nprint('You got it!')","q":"The while loop stops when?","o":["guess equals secret","never","after one try"],"a":0,"x":"It repeats while guess != secret, so it stops when they match."},
  {"e":"📊","t":"Tally Counter","b":"Count with a dictionary.","lv":"Ages 14+","xp":105,"p":"A dictionary can count how many times something appears.","c":"votes = ['cat', 'dog', 'cat']\ncount = {}\nfor v in votes:\n    count[v] = count.get(v, 0) + 1\nprint(count['cat'])","q":"What does count['cat'] show?","o":["2","1","3"],"a":0,"x":"'cat' appears twice, so the tally is 2."},
  {"e":"🌡️","t":"Temperature Converter","b":"Celsius to Fahrenheit.","lv":"Ages 13+","xp":100,"p":"A function can run a math formula for you any time.","c":"def to_f(c):\n    return c * 9 / 5 + 32\n\nprint(to_f(100))","q":"What does to_f(100) return?","o":["212.0","100","32"],"a":0,"x":"100*9/5+32 = 212.0, the boiling point in Fahrenheit."},
  {"e":"🔝","t":"Find the Biggest","b":"Find the max in a list.","lv":"Ages 14+","xp":105,"p":"Loop through and remember the biggest number you have seen.","c":"nums = [4, 9, 2, 7]\nbiggest = nums[0]\nfor n in nums:\n    if n > biggest:\n        biggest = n\nprint(biggest)","q":"What prints?","o":["9","4","7"],"a":0,"x":"9 is the largest number in the list."},
  {"e":"🔁","t":"Reverse a Word","b":"Flip text backwards.","lv":"Ages 14+","xp":105,"p":"The slice <code>[::-1]</code> reverses a string.","c":"word = 'code'\nprint(word[::-1])","q":"What does 'code'[::-1] give?","o":["'edoc'","'code'","'CODE'"],"a":0,"x":"[::-1] steps backwards, spelling 'code' as 'edoc'."},
  {"e":"🏆","t":"Mini Quiz Game","b":"Score the player.","lv":"Ages 14+","xp":115,"p":"Combine input, if, and a score variable to build a quiz.","c":"score = 0\nif input('2+2? ') == '4':\n    score = score + 1\nprint('Score:', score)","q":"What makes the score go up?","o":["a correct answer","any answer","running the code"],"a":0,"x":"score only increases when the typed answer equals '4'."},
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


# Class/teacher join codes: unambiguous characters only (no O/0/I/1).
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def gen_class_code(conn):
    """A unique 6-character classroom code kids type to join a teacher/district group."""
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if not conn.execute("SELECT 1 FROM users WHERE class_code=?", (code,)).fetchone():
            return code


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
        CREATE TABLE IF NOT EXISTS account_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT, name TEXT, username TEXT, password_hash TEXT, salt TEXT,
            email TEXT, plan TEXT, requested_by TEXT, status TEXT DEFAULT 'pending',
            created_at TEXT, resolved_at TEXT, resolved_by TEXT
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
        "brand_name": "TEXT", "brand_logo": "TEXT",   # school/district custom branding
        "quiz_done": "INTEGER DEFAULT 0", "quiz_level": "TEXT",   # placement quiz result
        "quiz_plan": "TEXT", "start_unit": "INTEGER",
        "class_code": "TEXT",   # teacher/district join code kids enter to join the group
        "stripe_customer_id": "TEXT", "stripe_subscription_id": "TEXT",   # real billing
    }
    for col, decl in add_cols.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
    # Every educator (teacher) account gets a unique class code; backfill any that are missing.
    for r in conn.execute("SELECT id FROM users WHERE role='teacher' AND (class_code IS NULL OR class_code='')").fetchall():
        conn.execute("UPDATE users SET class_code=? WHERE id=?", (gen_class_code(conn), r["id"]))
    conn.commit()
    conn.close()


def seed_settings():
    conn = db()
    row = conn.execute("SELECT value FROM settings WHERE key='plan_settings'").fetchone()
    if not row:
        conn.execute("INSERT INTO settings (key,value) VALUES ('plan_settings',?)", (json.dumps(DEFAULT_PLAN_SETTINGS),))
    conn.commit()
    conn.close()


LESSON_VERSION = "2026-152-lessons-v3"  # bump to refresh the lesson catalog (keeps users & progress)

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


def auth_enabled(kind):
    """kind = 'signups' or 'logins'. Default ON. Super admin can toggle these."""
    return bool(get_setting(kind + "_enabled", True))


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


DEFAULT_PLAN_BY_ROLE = {"teacher": "teacher", "parent": "family", "admin": "pro", "super_admin": "pro"}


def provision_account(role, name, username, pwhash, salt, email="", plan=None):
    """Create a real user row from already-hashed credentials. Returns uid, or None if username taken."""
    name = clean_name(name)
    if not plan:
        plan = DEFAULT_PLAN_BY_ROLE.get(role, "trial")
    link_token = secrets.token_urlsafe(8)
    avatar = json.dumps(DEFAULT_AVATAR)
    owned = json.dumps(list(FREE_ITEMS))
    conn = db()
    try:
        cur = conn.execute(
            "INSERT INTO users (role,name,username,password_hash,salt,parent_email,plan,tokens,avatar,"
            "owned_items,link_token,consent_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (role, name, username, pwhash, salt, email, plan, STARTER_TOKENS, avatar, owned,
             link_token, "not_required", now_iso()))
        conn.commit()
        uid = cur.lastrowid
    except sqlite3.IntegrityError:
        conn.close()
        return None
    if role in ("parent", "teacher"):   # adults manage their own family group
        conn.execute("UPDATE users SET family_id=? WHERE id=?", (uid, uid))
        if role == "teacher":
            conn.execute("UPDATE users SET class_code=? WHERE id=?", (gen_class_code(conn), uid))
        conn.commit()
    conn.close()
    return uid


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
# Ways to send a real email (otherwise it's a no-op and we just store the in-app message):
#   1. Outlook SMTP - set OUTLOOK_APP_PASSWORD (and OUTLOOK_USER, default kidvibers.help@outlook.com).
#                     Sends straight FROM the Outlook address. Preferred for the KidVibers mailbox.
#   2. Gmail SMTP   - set GMAIL_APP_PASSWORD (+ GMAIL_USER). Fallback; sends FROM the Gmail address.
#   3. Resend API   - set RESEND_API_KEY (needs a verified custom domain for the "from").
EMAIL_FROM_DEFAULT = "KidVibers <kidvibers.help@outlook.com>"


def _wrap_html(html):
    return f'<div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">{html}</div>'


def send_email_outlook(to, subject, html):
    user = os.environ.get("OUTLOOK_USER", "kidvibers.help@outlook.com")
    pw = os.environ.get("OUTLOOK_APP_PASSWORD")
    if not pw:
        return False
    frm = os.environ.get("EMAIL_FROM", f"KidVibers <{user}>")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = frm
    msg["To"] = to
    msg.set_content("This email needs an HTML-capable mail app to view.")
    msg.add_alternative(_wrap_html(html), subtype="html")
    ctx = ssl.create_default_context()
    with smtplib.SMTP("smtp-mail.outlook.com", 587, timeout=20) as s:
        s.starttls(context=ctx)
        s.login(user, pw)
        s.send_message(msg)
    return True


def send_email_gmail(to, subject, html):
    user = os.environ.get("GMAIL_USER")
    pw = os.environ.get("GMAIL_APP_PASSWORD")
    if not pw or not user:
        return False
    # Gmail rewrites/rejects a "From" that isn't the authenticated account, so send AS the Gmail
    # address but set Reply-To to the public KidVibers mailbox.
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"KidVibers <{user}>"
    msg["Reply-To"] = "kidvibers.help@outlook.com"
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
    payload = {"from": frm, "to": [to], "subject": subject, "html": _wrap_html(html),
               "reply_to": os.environ.get("REPLY_TO", "kidvibers.help@outlook.com")}
    body = json.dumps(payload).encode()
    # Resend/SES occasionally returns a transient 403/429 - retry a few times before giving up.
    last = None
    for attempt in range(4):
        req = urllib.request.Request("https://api.resend.com/emails", data=body, method="POST",
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=15)
            return True
        except Exception as e:
            last = e
            time.sleep(2 * (attempt + 1))   # 2s, 4s, 6s backoff
    raise last


def send_email(to, subject, html):
    """Try each configured provider in turn (Resend → Outlook → Gmail). A failure in one
    falls through to the next, so a dead credential never blocks a working provider."""
    if not to:
        return False
    for name, fn in (("resend", send_email_resend), ("outlook", send_email_outlook), ("gmail", send_email_gmail)):
        try:
            if fn(to, subject, html):
                print(f"email sent ({name}) -> {to}: {subject}")
                return True
        except Exception as e:
            print(f"email via {name} failed:", repr(e))
    return False

def send_email_async(to, subject, html):
    threading.Thread(target=send_email, args=(to, subject, html), daemon=True).start()


def get_super_admin_email():
    """Where moderation alerts go. Set SUPER_ADMIN_EMAIL to override."""
    return os.environ.get("SUPER_ADMIN_EMAIL", "kidvibers.help@outlook.com")


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
                return (False, until)  # time served - expired
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
    # Environment variables (e.g. set in the Render dashboard) override the file - the secure way to set creds in production.
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


def update_admin_config(role, username=None, password=None):
    """Persist admin / super-admin credential changes to admin_config.json so they survive restarts."""
    try:
        cfg = {}
        if os.path.exists(ADMIN_CONFIG):
            with open(ADMIN_CONFIG) as f:
                cfg = json.load(f)
        prefix = "super_admin" if role == "super_admin" else "admin"
        if username:
            cfg[f"{prefix}_username"] = username
        if password:
            cfg[f"{prefix}_password"] = password
        with open(ADMIN_CONFIG, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        print("could not update admin_config.json:", e)


def _seed_one(conn, role, username, password, name):
    # Create the admin/super-admin only if it doesn't exist yet. We do NOT overwrite an
    # existing account on every boot, so credential changes made in the dashboard persist.
    row = conn.execute("SELECT id FROM users WHERE role=? LIMIT 1", (role,)).fetchone()
    if row:
        return
    pwhash, salt = hash_password(password)
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
            "VALUES ('kid','KidVibers','c4k_showcase',?,?,'pro','not_required',0,?)",
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


# ────────────────────────────── Stripe ──────────────────────────────
def stripe_enabled():
    return bool(STRIPE_SECRET_KEY)


def stripe_request(path, params):
    """POST to the Stripe API with the secret key. Returns parsed JSON (raises on hard errors)."""
    data = urllib.parse.urlencode(params, doseq=True).encode()
    req = urllib.request.Request("https://api.stripe.com/v1" + path, data=data, method="POST")
    req.add_header("Authorization", "Bearer " + STRIPE_SECRET_KEY)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body).get("error", {}).get("message", body)
        except (ValueError, TypeError):
            msg = body
        raise RuntimeError(f"Stripe error: {msg}")


def stripe_plan_role_ok(plan, role):
    if plan in ("teacher", "school", "district"):
        return role in ("teacher", "super_admin")
    if plan in ("pro", "family"):
        return role in ("kid", "parent", "super_admin")
    return False


def stripe_verify_signature(payload_bytes, sig_header):
    """Verify a Stripe webhook signature (no SDK needed). Returns True/False."""
    if not STRIPE_WEBHOOK_SECRET or not sig_header:
        return False
    parts = dict(p.split("=", 1) for p in sig_header.split(",") if "=" in p)
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        return False
    signed = t.encode() + b"." + payload_bytes
    expected = hmac.new(STRIPE_WEBHOOK_SECRET.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, v1):
        return False
    try:                                  # reject events older than 5 minutes (replay protection)
        return abs(time.time() - int(t)) < 300
    except (TypeError, ValueError):
        return False


def teacher_plan_cfg(plan):
    return TEACHER_PLANS.get(plan, NO_TEACHER_PLAN)


# ── Placement quiz: turns 6 answer indices into a plan + starting world recommendation ──
# Answer indices (must match the quiz shown in app.js):
#  0 age:        0=6-8, 1=9-11, 2=12-14, 3=15+
#  1 experience: 0=never, 1=a little (blocks), 2=some Python, 3=I build things
#  2 interest:   0=games, 1=websites, 2=art & stories, 3=smart AI
#  3 practice:   0=here & there, 1=~15 min most days, 2=deep daily
#  4 helper:     0=yes please, 1=maybe later, 2=I figure it out myself
#  5 who:        0=just me, 1=me + siblings
PLAN_BLURB = {
    "free":   "Start free with starter lessons, badges and the avatar shop. Upgrade any time.",
    "pro":    "Pro unlocks every lesson plus Byte, your AI coding buddy, for hints and explanations.",
    "family": "The Family plan covers up to 4 kids with AI included, so everyone learns together.",
}
PLAN_LABEL = {"free": "Free", "pro": "Pro", "family": "Family"}


def recommend_from_quiz(a):
    age, exp, interest, practice, helper, who = (a + [0] * 6)[:6]

    # Skill level -> where to start
    if exp >= 2 and age >= 2:
        level, start_unit = "Pro Coder", 11          # teen / advanced track
    elif exp == 0 or age == 0:
        level, start_unit = "Beginner", 1            # Greenwood Basics from the top
    else:
        level = "Builder"
        start_unit = {0: 5, 1: 6, 3: 8}.get(interest, 2)   # games / web / AI / general

    bonus_unit = 15 if level == "Beginner" else 16   # Spark Lab vs Capstone Quests

    # Plan that fits how they want to learn
    if who == 1:
        plan = "family"
    elif helper == 0 or exp >= 2 or practice == 2:
        plan = "pro"
    else:
        plan = "free"

    interest_word = {0: "games", 1: "websites", 2: "art & stories", 3: "smart AI"}.get(interest, "code")
    return {
        "level": level,
        "plan": plan,
        "planLabel": PLAN_LABEL[plan],
        "planBlurb": PLAN_BLURB[plan],
        "startUnit": start_unit,
        "startWorld": UNIT_NAMES.get(start_unit, "Greenwood Basics"),
        "bonusUnit": bonus_unit,
        "bonusWorld": UNIT_NAMES.get(bonus_unit, ""),
        "title": f"You're a {level}!",
        "blurb": f"Based on your answers, we'll start you in {UNIT_NAMES.get(start_unit, 'Greenwood Basics')} "
                 f"and line up {interest_word} projects you'll love.",
    }


def students_in_family(family_id):
    if family_id is None:
        return 0
    conn = db()
    row = conn.execute("SELECT COUNT(*) c FROM users WHERE role='kid' AND family_id=?", (family_id,)).fetchone()
    conn.close()
    return row["c"]


def family_branding(family_id):
    """Custom school/district branding (set by the family's owner) - applied to that family's kids."""
    if family_id is None:
        return {"brandName": None, "brandLogo": None}
    conn = db()
    row = conn.execute("SELECT brand_name, brand_logo FROM users WHERE id=?", (family_id,)).fetchone()
    conn.close()
    if not row:
        return {"brandName": None, "brandLogo": None}
    return {"brandName": _row_get(row, "brand_name"), "brandLogo": _row_get(row, "brand_logo")}


def family_group(family_id):
    """If a kid belongs to an educator group, returns the label (District/School/Classroom) + name."""
    if family_id is None:
        return {}
    conn = db()
    row = conn.execute("SELECT role, plan, school, brand_name FROM users WHERE id=?", (family_id,)).fetchone()
    conn.close()
    if not row or row["role"] != "teacher":
        return {}   # regular parent-managed family - keep the normal plan label
    plan = row["plan"]
    label = "District" if plan == "district" else ("School" if plan == "school" else "Classroom")
    name = _row_get(row, "brand_name") or _row_get(row, "school") or label
    return {"groupLabel": label, "groupName": name}


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
                   "studentLimit": tp["students"], "studentsUsed": students_in_family(user["family_id"]),
                   "isDistrict": (user["plan"] in DISTRICT_PLANS),
                   "classCode": _row_get(user, "class_code"),
                   "brandName": _row_get(user, "brand_name"), "brandLogo": _row_get(user, "brand_logo")}
    # Kids inherit their school/district's branding + group label (shown on their dashboard).
    kid_brand = family_branding(user["family_id"]) if user["role"] == "kid" else {}
    kid_group = family_group(user["family_id"]) if user["role"] == "kid" else {}
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
        "hasBilling": bool(_row_get(user, "stripe_customer_id")),
        "quizDone": bool(_row_get(user, "quiz_done", 0)),
        "quizLevel": _row_get(user, "quiz_level"),
        "recommendedPlan": _row_get(user, "quiz_plan"),
        "startUnit": _row_get(user, "start_unit"),
        **kid_brand,
        **kid_group,
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
    server_version = "KidVibers/2.0"

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _client_ip(self):
        # Behind Cloudflare the real visitor IP is in CF-Connecting-IP (the socket is the tunnel).
        return (self.headers.get("CF-Connecting-IP")
                or self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
                or (self.client_address[0] if self.client_address else "?"))

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
        try:
            path = urlparse(self.path).path
            if path.startswith("/api/"):
                return self.handle_api_get(path)
            return self.serve_static(path)
        except Exception as e:
            self._safe_500(e)

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/stripe/webhook":
                # Stripe webhook: verify against the RAW body, so read it here.
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b""
                return self.api_stripe_webhook(raw, self.headers.get("Stripe-Signature", ""))
            if path.startswith("/api/"):
                return self.handle_api_post(path)
            return self._send_json({"error": "not found"}, 404)
        except Exception as e:
            self._safe_500(e)

    def _safe_500(self, e):
        # Never leak a stack trace to the client; log it server-side and return a generic error.
        print("request error:", repr(e))
        try:
            self._send_json({"error": "Something went wrong. Please try again."}, 500)
        except Exception:
            pass

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
            if not u or u["role"] not in ("parent", "teacher", "super_admin"):
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

        if path == "/api/site-message":  # public: the super admin's site-wide announcement
            m = get_setting("site_message", {})
            return self._send_json({"text": m.get("text", ""), "active": bool(m.get("active"))})

        if path == "/api/site-edits":  # public: visual-editor overrides (colors/text/blocks)
            e = get_setting("site_edits", {})
            u = self._current_user()
            return self._send_json({"colors": e.get("colors", {}), "texts": e.get("texts", {}),
                                    "blocks": e.get("blocks", {}),
                                    "canEdit": bool(u and u["role"] == "super_admin")})

        if path == "/api/site-config":  # public: whether sign-ups / logins are currently enabled
            return self._send_json({"signupsEnabled": auth_enabled("signups"),
                                    "loginsEnabled": auth_enabled("logins"),
                                    "stripeEnabled": stripe_enabled()})

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
            if not u or u["role"] not in ("parent", "teacher", "super_admin"):
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
            roles = ("kid", "parent", "teacher", "admin", "super_admin") if u["role"] == "super_admin" else ("kid", "parent", "teacher")
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

        if path == "/api/admin/account-requests":  # super admin: pending account-creation requests from admins
            u = self._current_user()
            if not u or u["role"] != "super_admin":
                return self._send_json({"error": "forbidden"}, 403)
            conn = db()
            rows = conn.execute("SELECT id,role,name,username,email,plan,requested_by,created_at "
                                "FROM account_requests WHERE status='pending' ORDER BY id DESC").fetchall()
            conn.close()
            return self._send_json({"requests": [{
                "id": r["id"], "role": r["role"], "name": r["name"], "username": r["username"],
                "email": r["email"], "plan": r["plan"], "requestedBy": r["requested_by"],
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
            "/api/school/branding": lambda: self.api_school_branding(data),
            "/api/school/student/suspend": lambda: self.api_school_student_suspend(data),
            "/api/school/student/credentials": lambda: self.api_school_student_credentials(data),
            "/api/quiz/submit": lambda: self.api_quiz_submit(data),
            "/api/class/join": lambda: self.api_class_join(data),
            "/api/teacher/new-code": lambda: self.api_teacher_new_code(data),
            "/api/consent/start": lambda: self.api_consent_start(data),
            "/api/consent/confirm": lambda: self.api_consent_confirm(data),
            "/api/consent/resend": lambda: self.api_consent_resend(data),
            "/api/checkout": lambda: self.api_checkout(data),
            "/api/checkout/session": lambda: self.api_checkout_session(data),
            "/api/billing/portal": lambda: self.api_billing_portal(data),
            "/api/admin/set-plan": lambda: self.api_set_plan(data),
            "/api/admin/consent": lambda: self.api_admin_consent(data),
            "/api/admin/notice": lambda: self.api_admin_notice(data),
            "/api/admin/delete-user": lambda: self.api_admin_delete_user(data),
            "/api/admin/suspend": lambda: self.api_admin_suspend(data),
            "/api/admin/set-credentials": lambda: self.api_admin_set_credentials(data),
            "/api/admin/create-account": lambda: self.api_admin_create_account(data),
            "/api/admin/site-message": lambda: self.api_admin_site_message(data),
            "/api/admin/site-edits": lambda: self.api_site_edits_save(data),
            "/api/admin/site-edits/publish": lambda: self._send_json({"ok": True}),
            "/api/admin/toggles": lambda: self.api_admin_toggles(data),
            "/api/admin/account-requests/resolve": lambda: self.api_admin_resolve_request(data),
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
            send_email_async(row["parent_email"], "Reset your KidVibers password",
                             f"<p>Hi {clean_name(row['name'] or '')}, we got a request to reset your KidVibers password.</p>"
                             f"<p><a href=\"{url}\">Click here to choose a new password</a> (link expires in 2 hours).</p>"
                             f"<p style=\"color:#777;font-size:0.9em\">If you didn't ask for this, you can ignore this email - your password won't change.</p>")
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
        if not auth_enabled("signups"):
            return self._send_json({"error": "Sign-ups are temporarily disabled. Please check back soon."}, 403)
        # Anti-abuse: cap new accounts per IP (real visitor IP via Cloudflare).
        if rate_limited(f"signup:{self._client_ip()}", 8, 3600):
            return self._send_json({"error": "Too many sign-ups from this network. Please try again later."}, 429)
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
            invite_body = (f"{name} just joined KidVibers! Tap “Sign My Kid and Myself Up” to create your "
                           f"parent account and connect to {name}: {invite_url}")
            conn = db()
            conn.execute("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)",
                         (email, "parent_invite", invite_body, uid, link_token, now_iso()))
            send_email_async(email, f"Connect to {name} on KidVibers",
                             f'{invite_body} <a href="{invite_url}">Sign My Kid and Myself Up →</a>')
            if needs_consent:
                consent_url = f"http://localhost:{PORT}/index.html?consent={consent_token}"
                consent_body = (f"Parental consent needed: {name} (under 13) wants to use KidVibers. As required by "
                                f"COPPA, please review and approve: {consent_url}")
                conn.execute("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)",
                             (email, "consent_request", consent_body, uid, consent_token, now_iso()))
                send_email_async(email, f"Approve {name}'s KidVibers account",
                                 f'{consent_body} <a href="{consent_url}">Review &amp; approve →</a>')
            conn.commit()
            conn.close()
        token = create_session(uid)
        return self._send_json({"token": token, "user": public_user(row),
                                "inviteToken": link_token, "inviteUrl": invite_url, "parentEmail": email,
                                "needsConsent": needs_consent, "consentToken": consent_token})

    def api_parent_signup(self, data):
        if not auth_enabled("signups"):
            return self._send_json({"error": "Sign-ups are temporarily disabled. Please check back soon."}, 403)
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
            # Welcome email to the address the parent signed up with (from kidvibers.help@outlook.com).
            if email:
                first = (name.split(" ")[0] or "there")
                link_line = (f" You're now connected to <strong>{clean_name(linked)}</strong>'s account."
                             if linked else "")
                welcome = (f"Hi {clean_name(first)}, welcome to KidVibers! 🎉 Your Family account is ready."
                           f"{link_line} From your Family Dashboard you can add kids, see their progress, "
                           f"approve accounts, and sign them in or out anytime. Happy coding!")
                # COPPA: include the parental-consent notice + a written record of consent in the email.
                consent_note = (
                    "Parental Consent (COPPA): As the parent or legal guardian, by creating this Family account "
                    "and adding or linking a child, you give verifiable parental consent for your child(ren) under 13 "
                    "to use KidVibers. We collect only what's needed to run the learning service (a first name, "
                    "username, age range, learning progress, and your contact email) - never more than necessary, "
                    "and we never sell it. There is no private messaging; shared projects and comments are moderated. "
                    "You can review or download your child's data, withdraw consent, or delete the account at any time "
                    "from your Family Dashboard or by emailing kidvibers.help@outlook.com.")
                consent_record = ""
                if linked:
                    consent_record = (f"<br><br>Consent recorded: {now_iso()} - you approved {clean_name(linked)}'s account "
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
                send_email_async(email, "Welcome to KidVibers - your account & parental consent 🎉",
                                 f"{welcome}<br><br><a href=\"{dash_url}\">Open your Family Dashboard →</a>{consent_html}")
            token = create_session(uid)
            return self._send_json({"token": token, "user": public_user(row), "linkedChild": linked})
        return resp  # error response already sent

    def _validate_credentials(self, name, username, password):
        if not name or not username or not password:
            return "Name, username and password are required."
        if len(name) > 60:
            return "Name is too long (max 60 characters)."
        if not USERNAME_RE.match(username):
            return "Username must be 3-20 letters, numbers or underscores."
        if len(password) < 6:
            return "Password must be at least 6 characters."
        if len(password) > 200:
            return "Password is too long."
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
        # Super admin can turn off logins for everyone except admins (so they can still get in).
        if not auth_enabled("logins") and row["role"] not in ADMIN_ROLES:
            return self._send_json({"error": "Logins are temporarily disabled. Please check back soon."}, 403)
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
                msg += " Please contact kidvibers.help@outlook.com."
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
            return self._send_json({"error": f"Not enough tokens - you need {price} 🪙"}, 400)
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
            send_email_async(parent_email, "Your kid wants to upgrade KidVibers", body)
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
            limit = cfg["students"]   # -1 = unlimited
            if limit != -1 and students_in_family(u["family_id"]) >= limit:
                msg = ("Choose a Teacher, School or District plan to add students."
                       if limit == 0 else
                       f"Your {cfg['label']} allows {limit} students. Upgrade for more.")
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
        if not auth_enabled("signups"):
            return self._send_json({"error": "Sign-ups are temporarily disabled. Please check back soon."}, 403)
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
        conn.execute("UPDATE users SET family_id=?, class_code=? WHERE id=?",
                     (uid, gen_class_code(conn), uid))  # classroom = family group + a join code
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
        # Teacher/school/district tiers for educators; Pro/Family for kids & parents.
        if plan in ("teacher", "school", "district"):
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
        # We're not charging real cards yet - be upfront that no money was taken.
        if u["parent_email"]:
            send_email_async(u["parent_email"], "About your KidVibers plan",
                             "<p>Thanks for your interest in upgrading! <strong>You have not been charged.</strong></p>"
                             "<p>We're currently not accepting new paid plans yet - we'll have that solved soon. "
                             "We'll let you know the moment billing is ready.</p>"
                             "<p>Thanks for your patience! 💜<br>- The KidVibers Team</p>")
        return self._send_json({"ok": True, "plan": plan, "user": public_user(row),
                                "notCharged": True})

    def api_checkout_session(self, data):
        """Create a real Stripe Checkout Session (hosted payment page). Falls back to
        simulated mode when Stripe isn't configured."""
        u = self._current_user()
        if not u:
            return self._send_json({"error": "Please log in to upgrade."}, 401)
        plan = (data.get("plan") or "").strip()
        if plan not in ("pro", "family", "teacher", "school", "district"):
            return self._send_json({"error": "Unknown plan."}, 400)
        if not stripe_plan_role_ok(plan, u["role"]):
            return self._send_json({"error": "This account type can't purchase that plan."}, 403)
        price = STRIPE_PRICES.get(plan)
        if not stripe_enabled() or not price:
            # Stripe not set up yet -> tell the front-end to use the simulated flow.
            return self._send_json({"simulated": True})
        params = {
            "mode": "subscription",
            "line_items[0][price]": price,
            "line_items[0][quantity]": 1,
            "success_url": f"{SITE_URL}/checkout.html?status=success&plan={plan}",
            "cancel_url": f"{SITE_URL}/checkout.html?plan={plan}&status=cancel",
            "client_reference_id": str(u["id"]),
            "metadata[user_id]": str(u["id"]),
            "metadata[plan]": plan,
            "allow_promotion_codes": "true",
        }
        if u["parent_email"]:
            params["customer_email"] = u["parent_email"]
        try:
            session = stripe_request("/checkout/sessions", params)
        except RuntimeError as e:
            print("stripe session error:", e)
            return self._send_json({"error": "Could not start checkout. Please try again."}, 502)
        return self._send_json({"url": session.get("url")})

    def api_stripe_webhook(self, raw_body, sig_header):
        """Stripe calls this after a payment. We verify the signature, then upgrade the plan."""
        if not stripe_verify_signature(raw_body, sig_header):
            return self._send_json({"error": "bad signature"}, 400)
        try:
            event = json.loads(raw_body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._send_json({"error": "bad payload"}, 400)
        etype = event.get("type")
        obj = event.get("data", {}).get("object", {})
        if etype == "checkout.session.completed":
            uid = obj.get("client_reference_id") or obj.get("metadata", {}).get("user_id")
            plan = obj.get("metadata", {}).get("plan")
            if uid and plan:
                conn = db()
                row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                if row:
                    conn.execute("UPDATE users SET plan=?, stripe_customer_id=?, stripe_subscription_id=? WHERE id=?",
                                 (plan, obj.get("customer"), obj.get("subscription"), uid))
                    conn.commit()
                    if row["parent_email"]:
                        send_email_async(row["parent_email"], "Your KidVibers plan is active 🎉",
                                         f"<p>Thanks for subscribing! Your <strong>{plan.title()}</strong> plan is now active.</p>"
                                         "<p>You can manage or cancel anytime from your dashboard.</p>"
                                         "<p>- The KidVibers Team 💜</p>")
                conn.close()
        elif etype in ("customer.subscription.deleted",):
            # Subscription ended/canceled -> drop kid plans back to free.
            sub_id = obj.get("id")
            if sub_id:
                conn = db()
                row = conn.execute("SELECT * FROM users WHERE stripe_subscription_id=?", (sub_id,)).fetchone()
                if row:
                    downgrade = "free" if row["role"] in ("kid", "parent") else "none"
                    conn.execute("UPDATE users SET plan=?, stripe_subscription_id=NULL WHERE id=?", (downgrade, row["id"]))
                    conn.commit()
                conn.close()
        return self._send_json({"received": True})

    def api_billing_portal(self, data):
        """Open the Stripe customer portal so a subscriber can update or cancel billing."""
        u = self._current_user()
        if not u:
            return self._send_json({"error": "Please log in."}, 401)
        if not stripe_enabled() or not _row_get(u, "stripe_customer_id"):
            return self._send_json({"error": "No billing account to manage yet."}, 400)
        try:
            session = stripe_request("/billing_portal/sessions",
                                     {"customer": u["stripe_customer_id"], "return_url": f"{SITE_URL}/dashboard.html"})
        except RuntimeError as e:
            print("stripe portal error:", e)
            return self._send_json({"error": "Could not open billing. Please try again."}, 502)
        return self._send_json({"url": session.get("url")})

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
            send_email_async(target["parent_email"], "A message from KidVibers", msg)
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
        if target["role"] == "super_admin":
            conn.close()
            return self._send_json({"error": "The super-admin account can't be deleted."}, 403)
        uid = target["id"]
        # Keep a record of the deletion + reason (e.g. for the parent on file).
        if target["parent_email"]:
            body = (f"Notice: the KidVibers account '{target['name']}' (@{target['username']}) has been deleted by an administrator."
                    + (f" Reason: {reason}" if reason else ""))
            conn.execute("INSERT INTO messages (to_email,kind,body,child_id,created_at) VALUES (?,?,?,?,?)",
                         (target["parent_email"], "account_deleted", body, uid, now_iso()))
            send_email_async(target["parent_email"], "KidVibers account deleted", body)
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
        if target["role"] == "super_admin":
            conn.close()
            return self._send_json({"error": "The super-admin account can't be suspended."}, 403)
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
                body = (f"Notice: the KidVibers account '{target['name']}' (@{target['username']}) has been "
                        f"suspended by an administrator{until_phrase}." + (f" Reason: {reason}" if reason else "")
                        + " Contact kidvibers.help@outlook.com with questions.")
                subject = "KidVibers account suspended"
            else:
                body = (f"Good news: the KidVibers account '{target['name']}' (@{target['username']}) has been "
                        f"reinstated and can be used again.")
                subject = "KidVibers account reinstated"
            conn2 = db()
            conn2.execute("INSERT INTO messages (to_email,kind,body,child_id,created_at) VALUES (?,?,?,?,?)",
                          (target["parent_email"], "account_suspended" if suspend else "account_reinstated", body, uid, now_iso()))
            conn2.commit()
            conn2.close()
            send_email_async(target["parent_email"], subject, body)
        log_consent(uid, target["username"], "suspended" if suspend else "reinstated",
                    f"super admin ({admin['username']})", (reason + until_phrase) if suspend else "")
        return self._send_json({"ok": True, "name": target["name"], "suspended": suspend, "until": until})

    def api_admin_set_credentials(self, data):
        """Super admin sets a new username and/or password for any account (kid/parent/teacher/admin)."""
        admin = self._current_user()
        if not admin or admin["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        conn = db()
        target = conn.execute("SELECT * FROM users WHERE id=?", (data.get("userId"),)).fetchone()
        if not target:
            conn.close()
            return self._send_json({"error": "Account not found."}, 404)
        new_user = (data.get("username") or "").strip()
        new_pass = data.get("password") or ""
        if not new_user and not new_pass:
            conn.close()
            return self._send_json({"error": "Enter a new username and/or password."}, 400)

        changed = []
        if new_user and new_user != target["username"]:
            if not USERNAME_RE.match(new_user):
                conn.close()
                return self._send_json({"error": "Username must be 3-20 letters, numbers or underscores."}, 400)
            dup = conn.execute("SELECT 1 FROM users WHERE username=? AND id<>?", (new_user, target["id"])).fetchone()
            if dup:
                conn.close()
                return self._send_json({"error": "That username is already taken."}, 409)
            conn.execute("UPDATE users SET username=? WHERE id=?", (new_user, target["id"]))
            changed.append("username")
        if new_pass:
            if len(new_pass) < 6:
                conn.close()
                return self._send_json({"error": "Password must be at least 6 characters."}, 400)
            pwhash, salt = hash_password(new_pass)
            conn.execute("UPDATE users SET password_hash=?, salt=? WHERE id=?", (pwhash, salt, target["id"]))
            # changing a password logs that account out of existing sessions
            conn.execute("DELETE FROM sessions WHERE user_id=?", (target["id"],))
            changed.append("password")
        conn.commit()
        conn.close()
        # keep admin_config.json in sync so admin/super-admin changes persist across restarts
        if target["role"] in ("admin", "super_admin"):
            update_admin_config(target["role"],
                                username=new_user if "username" in changed else None,
                                password=new_pass if "password" in changed else None)
        return self._send_json({"ok": True, "changed": changed,
                                "username": new_user if "username" in changed else target["username"]})

    def api_admin_toggles(self, data):
        """Super admin enables/disables public sign-ups and logins (admin login always works)."""
        u = self._current_user()
        if not u or u["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        if "signups" in data:
            set_setting("signups_enabled", bool(data.get("signups")))
        if "logins" in data:
            set_setting("logins_enabled", bool(data.get("logins")))
        return self._send_json({"ok": True, "signupsEnabled": auth_enabled("signups"),
                                "loginsEnabled": auth_enabled("logins")})

    def api_admin_site_message(self, data):
        """Super admin sets (or clears) the site-wide announcement banner shown to everyone."""
        u = self._current_user()
        if not u or u["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        text = clean_name(data.get("text") or "")[:300]
        active = bool(data.get("active")) and bool(text)
        set_setting("site_message", {"text": text, "active": active})
        return self._send_json({"ok": True, "active": active})

    def api_site_edits_save(self, data):
        """Super admin saves the visual-editor overrides (colors / text / blocks)."""
        u = self._current_user()
        if not u or u["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        clean = {"colors": data.get("colors") or {}, "texts": data.get("texts") or {}, "blocks": data.get("blocks") or {}}
        if len(json.dumps(clean)) > 4_000_000:
            return self._send_json({"error": "Too much content/images to save."}, 413)
        set_setting("site_edits", clean)
        return self._send_json({"ok": True})

    def api_admin_create_account(self, data):
        """Super admin creates an account directly; a regular admin's submission becomes a pending request."""
        u = self._current_user()
        if not u or u["role"] not in ADMIN_ROLES:
            return self._send_json({"error": "forbidden"}, 403)
        role = (data.get("role") or "").strip()
        name = (data.get("name") or "").strip()
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        email = (data.get("email") or "").strip()
        plan = (data.get("plan") or "").strip() or None
        if role not in ("kid", "parent", "teacher", "admin"):
            return self._send_json({"error": "Pick a valid account type."}, 400)
        err = self._validate_credentials(name, username, password)
        if err:
            return self._send_json({"error": err}, 400)
        # username must be free in users AND not already requested
        conn = db()
        taken = conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone() or \
                conn.execute("SELECT 1 FROM account_requests WHERE username=? AND status='pending'", (username,)).fetchone()
        conn.close()
        if taken:
            return self._send_json({"error": "That username is already taken or pending."}, 409)
        pwhash, salt = hash_password(password)
        name = clean_name(name)

        if u["role"] == "super_admin":
            uid = provision_account(role, name, username, pwhash, salt, email, plan)
            if not uid:
                return self._send_json({"error": "That username is already taken."}, 409)
            return self._send_json({"ok": True, "created": True, "role": role, "username": username})

        # regular admin → queue a request for the super admin to approve
        conn = db()
        conn.execute("INSERT INTO account_requests (role,name,username,password_hash,salt,email,plan,requested_by,status,created_at) "
                     "VALUES (?,?,?,?,?,?,?,?,'pending',?)",
                     (role, name, username, pwhash, salt, email, plan, u["username"], now_iso()))
        conn.commit()
        conn.close()
        send_email_async(get_super_admin_email(), "New account request on KidVibers",
                         f"<p>Admin <strong>{clean_name(u['username'])}</strong> requested a new "
                         f"<strong>{role}</strong> account: {clean_name(name)} (@{clean_name(username)}).</p>"
                         f"<p>Approve or decline it in the Super Admin dashboard → Account Requests.</p>")
        return self._send_json({"ok": True, "pending": True, "role": role, "username": username})

    def api_admin_resolve_request(self, data):
        """Super admin approves (creates the account) or declines an admin's account request."""
        u = self._current_user()
        if not u or u["role"] != "super_admin":
            return self._send_json({"error": "forbidden"}, 403)
        action = (data.get("action") or "").strip()
        if action not in ("approve", "decline"):
            return self._send_json({"error": "bad action"}, 400)
        conn = db()
        r = conn.execute("SELECT * FROM account_requests WHERE id=?", (data.get("id"),)).fetchone()
        if not r or r["status"] != "pending":
            conn.close()
            return self._send_json({"error": "Request not found or already handled."}, 404)
        conn.close()
        if action == "approve":
            # username may have been taken since the request was made
            conn = db()
            taken = conn.execute("SELECT 1 FROM users WHERE username=?", (r["username"],)).fetchone()
            conn.close()
            if taken:
                self._set_request_status(r["id"], "declined", u["username"])
                return self._send_json({"error": "Username is now taken; request declined."}, 409)
            uid = provision_account(r["role"], r["name"], r["username"], r["password_hash"], r["salt"],
                                    r["email"] or "", r["plan"])
            if not uid:
                self._set_request_status(r["id"], "declined", u["username"])
                return self._send_json({"error": "Could not create (username taken). Request declined."}, 409)
            self._set_request_status(r["id"], "approved", u["username"])
            return self._send_json({"ok": True, "status": "approved", "username": r["username"]})
        else:
            self._set_request_status(r["id"], "declined", u["username"])
            return self._send_json({"ok": True, "status": "declined"})

    def _set_request_status(self, req_id, status, by):
        conn = db()
        conn.execute("UPDATE account_requests SET status=?, resolved_at=?, resolved_by=? WHERE id=?",
                     (status, now_iso(), by, req_id))
        conn.commit()
        conn.close()

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

    # ───────────── District / Library dashboard (school & district plans) ─────────────
    def _district_owner(self):
        """Returns the current user if they're a teacher account on a School/District plan, else None."""
        u = self._current_user()
        if not u or u["role"] != "teacher" or u["family_id"] is None:
            return None
        if u["plan"] not in DISTRICT_PLANS:
            return None
        return u

    def _district_student(self, conn, owner, kid_id):
        """Fetch a kid row that belongs to this owner's school/district, or None."""
        return conn.execute("SELECT * FROM users WHERE id=? AND role='kid' AND family_id=?",
                            (kid_id, owner["family_id"])).fetchone()

    def api_school_branding(self, data):
        """School/district owner sets their org name + logo, shown to their students."""
        owner = self._district_owner()
        if not owner:
            return self._send_json({"error": "Only a School or District account can change branding."}, 403)
        brand_name = (data.get("brandName") or "").strip()[:80]
        brand_logo = (data.get("brandLogo") or "").strip()[:500]
        if brand_logo and not re.match(r"^https://", brand_logo):
            return self._send_json({"error": "Logo must be a secure https:// image link."}, 400)
        conn = db()
        conn.execute("UPDATE users SET brand_name=?, brand_logo=? WHERE id=?",
                     (brand_name or None, brand_logo or None, owner["id"]))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "brandName": brand_name or None, "brandLogo": brand_logo or None})

    def api_school_student_suspend(self, data):
        """School/district owner suspends (or restores) one of their own students."""
        owner = self._district_owner()
        if not owner:
            return self._send_json({"error": "Only a School or District account can do this."}, 403)
        conn = db()
        kid = self._district_student(conn, owner, data.get("kidId"))
        if not kid:
            conn.close()
            return self._send_json({"error": "That student isn't in your school."}, 403)
        suspend = bool(data.get("suspended"))
        reason = (data.get("reason") or "").strip()[:200]
        until = None
        if suspend:
            try:
                days = float(data.get("days") or 0)
            except (TypeError, ValueError):
                days = 0
            if days and days > 0:
                until = (datetime.datetime.utcnow() + datetime.timedelta(days=days)).replace(microsecond=0).isoformat() + "Z"
            conn.execute("UPDATE users SET suspended=1, suspend_reason=?, suspend_until=? WHERE id=?",
                         (reason or f"Suspended by {owner['school'] or 'your school'}", until, kid["id"]))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (kid["id"],))
        else:
            clear_suspension(conn, kid["id"])
        conn.commit()
        conn.close()
        log_consent(kid["id"], kid["username"], "suspended" if suspend else "reinstated",
                    f"school owner ({owner['username']})", reason)
        return self._send_json({"ok": True, "name": kid["name"], "suspended": suspend, "until": until})

    def api_school_student_credentials(self, data):
        """School/district owner changes a student's username and/or password."""
        owner = self._district_owner()
        if not owner:
            return self._send_json({"error": "Only a School or District account can do this."}, 403)
        conn = db()
        kid = self._district_student(conn, owner, data.get("kidId"))
        if not kid:
            conn.close()
            return self._send_json({"error": "That student isn't in your school."}, 403)
        new_user = (data.get("username") or "").strip()
        new_pass = data.get("password") or ""
        if not new_user and not new_pass:
            conn.close()
            return self._send_json({"error": "Enter a new username and/or password."}, 400)
        changed = []
        if new_user and new_user != kid["username"]:
            if not USERNAME_RE.match(new_user):
                conn.close()
                return self._send_json({"error": "Username must be 3-20 letters, numbers or underscores."}, 400)
            dup = conn.execute("SELECT 1 FROM users WHERE username=? AND id<>?", (new_user, kid["id"])).fetchone()
            if dup:
                conn.close()
                return self._send_json({"error": "That username is already taken."}, 409)
            conn.execute("UPDATE users SET username=? WHERE id=?", (new_user, kid["id"]))
            changed.append("username")
        if new_pass:
            if len(new_pass) < 6:
                conn.close()
                return self._send_json({"error": "Password must be at least 6 characters."}, 400)
            pwhash, salt = hash_password(new_pass)
            conn.execute("UPDATE users SET password_hash=?, salt=? WHERE id=?", (pwhash, salt, kid["id"]))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (kid["id"],))
            changed.append("password")
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "changed": changed,
                                "username": new_user if "username" in changed else kid["username"]})

    def api_class_join(self, data):
        """A kid types a teacher/district class code to join that classroom group."""
        u = self._current_user()
        if not u or u["role"] != "kid":
            return self._send_json({"error": "Only a kid account can join a classroom."}, 403)
        code = (data.get("code") or "").strip().upper().replace(" ", "")
        if not code:
            return self._send_json({"error": "Enter your class code."}, 400)
        conn = db()
        teacher = conn.execute("SELECT * FROM users WHERE role='teacher' AND class_code=?", (code,)).fetchone()
        if not teacher:
            conn.close()
            return self._send_json({"error": "That class code wasn't found. Double-check it with your teacher."}, 404)
        cfg = teacher_plan_cfg(teacher["plan"])
        limit = cfg["students"]   # -1 = unlimited
        used = conn.execute("SELECT COUNT(*) c FROM users WHERE role='kid' AND family_id=?",
                            (teacher["family_id"],)).fetchone()["c"]
        if limit != -1 and used >= limit:
            conn.close()
            return self._send_json({"error": "That classroom is full. Ask your teacher for help."}, 403)
        granted_by = (teacher["school"] or teacher["username"]) + f" (code {code})"
        # Joining a class moves the kid into that group, with school/classroom consent.
        conn.execute("UPDATE users SET family_id=?, plan='family', consent_status='granted', "
                     "consent_method='class_code', consent_by=?, consent_at=? WHERE id=?",
                     (teacher["family_id"], granted_by, now_iso(), u["id"]))
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
        conn.close()
        log_consent(u["id"], u["username"], "class_join", granted_by, f"Joined classroom via code {code}")
        grp = family_group(teacher["family_id"])
        return self._send_json({"ok": True, "user": public_user(row),
                                "groupName": grp.get("groupName") or (teacher["school"] or "the classroom"),
                                "groupLabel": grp.get("groupLabel") or "Classroom"})

    def api_teacher_new_code(self, data):
        """A teacher/district owner regenerates their class join code."""
        u = self._current_user()
        if not u or u["role"] != "teacher":
            return self._send_json({"error": "Only a teacher account has a class code."}, 403)
        conn = db()
        code = gen_class_code(conn)
        conn.execute("UPDATE users SET class_code=? WHERE id=?", (code, u["id"]))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "classCode": code})

    def api_quiz_submit(self, data):
        """A kid completes the placement quiz; we store + return a plan + starting-world recommendation."""
        u = self._current_user()
        if not u or u["role"] != "kid":
            return self._send_json({"error": "Only a kid account can take the placement quiz."}, 403)
        answers = data.get("answers")
        if not isinstance(answers, list) or len(answers) < 6:
            return self._send_json({"error": "Please answer all the questions."}, 400)
        try:
            a = [max(0, int(x)) for x in answers[:6]]
        except (TypeError, ValueError):
            return self._send_json({"error": "Invalid answers."}, 400)
        rec = recommend_from_quiz(a)
        conn = db()
        conn.execute("UPDATE users SET quiz_done=1, quiz_level=?, quiz_plan=?, start_unit=? WHERE id=?",
                     (rec["level"], rec["plan"], rec["startUnit"], u["id"]))
        conn.commit()
        conn.close()
        return self._send_json({"ok": True, "recommendation": rec})

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
        body = (f"Parental consent needed: {kid['name']} (under 13) wants to use KidVibers. As required by "
                f"COPPA, please review and approve: {consent_url}")
        conn.execute("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)",
                     (parent_email, "consent_request", body, u["id"], tok, now_iso()))
        conn.commit()
        conn.close()
        send_email_async(parent_email, f"Approve {kid['name']}'s KidVibers account",
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
        # let the super admin know there's something to review - show the actual reported message.
        author = clean_name(c["author_name"] or "") or "?"
        author_un = clean_name(_row_get(c, "author_username") or "")
        project = clean_name(_row_get(c, "project_title") or "(unknown project)")
        reporter = clean_name(u["username"] or "")
        body_html = (
            f"<p>A comment was reported on KidVibers and needs review.</p>"
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
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        # Restrict where scripts/styles/images/fonts may load from. 'unsafe-inline' is needed
        # for the site's inline handlers/styles and 'unsafe-eval' for Skulpt (in-browser Python).
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; "
                         "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; "
                         "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                         "font-src 'self' https://fonts.gstatic.com; "
                         "img-src 'self' data: https://api.dicebear.com https://api.qrserver.com; "
                         "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; "
                         "object-src 'none'; form-action 'self'")

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
        return "An <code>if</code> statement makes choices! 🤔 <code>if score > 10:<br>&nbsp;&nbsp;print('You win!')</code> - don't forget the colon!"
    if re.search(r"function", q):
        return "A function is a reusable mini-program! 🛠️ <code>def hello():<br>&nbsp;&nbsp;print('Hi!')</code> - call it with <code>hello()</code>."
    if re.search(r"error|bug|broken|not work", q):
        return "Every coder gets errors! 🐛 Read the last line, check for a missing <code>:</code> or <code>)</code>, and try again. You've got this!"
    if re.search(r"python|javascript|language", q):
        return "Great question! 🐍 Python is super beginner-friendly. You start with blocks, then move to real Python on KidVibers!"
    if re.search(r"\b(hi|hello|hey)\b", q):
        return "Hey there, coder! 👋 What do you want to learn today? Loops, variables, functions - just ask!"
    if re.search(r"thank", q):
        return "You're so welcome! 🌟 Keep up the awesome coding - I'm always here to help!"
    return "Ooh, good question! 🤖 I'm best at coding basics - try asking about <code>variables</code>, <code>loops</code>, <code>if statements</code>, or <code>functions</code>!"


def main():
    init_db()
    seed_settings()
    seed_lessons()
    seed_admins()
    seed_sample_projects()   # gallery sample projects (kept)
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"KidVibers backend running at http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
