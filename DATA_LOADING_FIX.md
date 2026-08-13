# Data loading fix

The startup timeout was caused by loading every move, ability, item, and species JSON file sequentially.
The loader now requests each collection concurrently, and the startup guard is 45 seconds for a cold deployment.
No `npm install` or `npm start` is required for the static Vercel build.
