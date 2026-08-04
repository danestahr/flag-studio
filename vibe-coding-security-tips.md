# 10 Tips for Shipping Vibe-Coded Apps Safely

1. **Run a security check before anyone uses it.**
   Ask Claude directly: "Run a security assessment of my code and flag any vulnerabilities." Takes 30 seconds. Do it before you share the link with anyone outside your circle.

2. **Keep your API keys secret, and check if they already aren't.**
   When you connect to outside services like payments, email, or maps, you get an API Key. Think of it as a password tied to your credit card or your account. Every tool you're using (Lovable, Replit, Supabase, Cloudflare) has a dedicated section in its settings called Secrets, Keys, or Environment Variables. That is the only place your API keys should ever live. If you find yourself copying a key directly into a code file, stop. Ask Claude: "Where should I store this API key in my current setup?" and it will tell you exactly where to put it for your specific tools. Then, before you share your code with anyone on GitHub, ask Claude: "Are there any API keys or secrets exposed in my codebase?" because the most common mistake is pasting a key into a file once, forgetting about it, and pushing it to the world.

3. **Lock your database.**
   If anyone on the internet can pull data from your app without logging in, you have a serious problem. Supabase has a feature called Row Level Security. Ask Claude or Lovable to confirm it's turned on. This single step prevents the most common way vibe-coded apps get exploited.

4. **Push your code to GitHub today.**
   If your code only lives on your laptop, one accident and it's gone. GitHub is like Google Drive for code: free, keeps full history, and lets you roll back if something breaks. If your project is private or confidential, mark the repository as Private.

5. **Keep the code lean.**
   Ask your AI tool to generate the minimum code necessary to make something work. Less code means easier to fix, easier to hand off, and cheaper to maintain. If you ever bring in a developer, they'll thank you. Bloated AI-generated codebases can cost weeks of cleanup before real work begins.

6. **Ask for error handling.**
   When you're prompting Claude or Lovable to build your API layer, the layer that connects your app to your database, add this: "Build a robust error handling framework." In plain terms: if something breaks, you want a clear message explaining what went wrong, not a blank white screen and a confused user.

7. **Set a spending cap on every service you connect.**
   Supabase, your hosting platform, your email service, they all charge based on usage. A traffic spike or a bug that accidentally loops thousands of requests can generate a surprise bill. Before you go live, set a spending cap or billing alert on every service. Most of them offer this in their settings for free.

8. **Get your own domain.**
   Lovable gives you a default URL, but you'll want your own eventually. Buy a domain on GoDaddy or Namecheap, think of it like buying a street address for your app. I use Cloudflare to manage mine: it's free for the basics, fast, and adds a security layer on top of everything else.

9. **Don't over-engineer early.**
   If your app is working on the stack your AI tool chose, leave it alone. There is no prize for adding complexity to something that's already running. The time to upgrade your infrastructure is when your current setup starts failing, not before.

10. **Don't build your own login system.**
    Authentication, the system that handles sign-ups, logins, and passwords, is notoriously hard to get right, and the consequences of getting it wrong fall on your users, not just you. The good news: you don't need to build it. Supabase has authentication built in and supports email, password, Google login, Apple login, and more, all with a single prompt. Ask Claude or Lovable: "Set up authentication using Supabase Auth with Google login." Never store passwords yourself. Never build a custom login flow from scratch. This is one area where using what already exists is always the right call.
