#!/usr/bin/env python3
"""Send a one-off practice email to verify sending works.

Usage:
    GMAIL_APP_PASSWORD='your16charapppassword' python3 test_email.py [recipient]

GMAIL_USER defaults to coding4kids.support@gmail.com.
Get an App Password at: https://myaccount.google.com/apppasswords
(2-Step Verification must be ON for that Google account first.)
"""
import os
import sys
from server import send_email

to = sys.argv[1] if len(sys.argv) > 1 else "elishalclark@icloud.com"
html = (
    "<h2>✅ It works!</h2>"
    "<p>This is a <strong>practice email</strong> from KidVibers.</p>"
    "<p>If you're reading this in your inbox, real email sending is set up correctly — "
    "parent welcome emails, consent notices, and moderation alerts will now go out.</p>"
    "<p style='color:#777;font-size:0.9em'>Sent from coding4kids.support@gmail.com</p>"
)
ok = send_email(to, "KidVibers — practice email 🎉", html)
if ok:
    print(f"\n✅ Sent a practice email to {to}. Check the inbox (and spam folder).")
else:
    print("\n❌ Not sent — no email credential is set.")
    print("   Set GMAIL_APP_PASSWORD (and 2-Step Verification on the Gmail account), then re-run:")
    print(f"   GMAIL_APP_PASSWORD='xxxxxxxxxxxxxxxx' python3 test_email.py {to}")
