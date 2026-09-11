const fs = require('fs')
const js = fs.readFileSync('ui/dist/assets/admin.js', 'utf8')
const html = fs.readFileSync('ui/dist/index.html', 'utf8')
const ids = new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]))
const missing = [...ids].filter(id => !html.includes('id="' + id + '"'))
console.log('unique selectors:', ids.size)
console.log('missing in HTML:', missing.length ? missing.join(', ') : 'NONE')
// also check querySelectorAll class hooks used
const classes = ['tab', 'row-select']
for (const c of classes) console.log('uses class .' + c + ':', js.includes(c))
