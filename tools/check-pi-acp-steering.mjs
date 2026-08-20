#!/usr/bin/env node
/**
 * ID01-435 — Check proactivo de la capability steering del adapter pi-acp.
 *
 * Verifica que el dist objetivo contenga:
 *   1. el método ext `_session/steering`
 *   2. la capability `initialize._meta.steering.supported = true` (forma compilada)
 *
 * Uso:
 *   node ~/comet/tools/check-pi-acp-steering.mjs            # dist live (glob de ~/.zeron/adapters)
 *   node ~/comet/tools/check-pi-acp-steering.mjs <path>     # archivo específico (p.ej. backup .orig)
 *
 * Exit 0 = capability presente · Exit 1 = falta algo (el mensaje nombra el remedio).
 * Solo lectura: no toca el dist, no se engancha al boot del engine.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REMEDY = 'node ~/comet/tools/patch_piacp.mjs  # luego re-verificá con este mismo check'

function resolveTarget() {
  if (process.argv[2]) {
    const p = process.argv[2]
    if (!existsSync(p)) {
      console.error(`✗ no existe: ${p}`)
      process.exit(1)
    }
    return p
  }
  const adaptersDir = join(homedir(), '.zeron', 'adapters', 'pi-acp')
  if (!existsSync(adaptersDir)) {
    console.error(`✗ no hay directorio de adapters: ${adaptersDir}`)
    process.exit(1)
  }
  // Install dirs are full git SHAs (fork pin, crates/harness/src/acp/mod.rs
  // npm_package github:davidhs26/pi-acp#<sha>) or legacy npm semver.
  const FORK_SHA = '7a8548ca739f6da56ef8b90f36c683ed1fdf70e7'
  const SEMVER_PIN = '0.0.33'
  const entries = readdirSync(adaptersDir).filter(
    d => /^[0-9a-f]{40}$/.test(d) || /^\d+\.\d+\.\d+$/.test(d)
  )
  if (entries.length === 0) {
    console.error(`✗ sin installs (SHA ni semver) en ${adaptersDir}`)
    process.exit(1)
  }
  const distFor = v => join(adaptersDir, v, 'node_modules', 'pi-acp', 'dist', 'index.js')
  // Prefer the engine's fork SHA, then the old semver pin, then whatever exists.
  const chosen = [FORK_SHA, SEMVER_PIN, ...entries].find(v => existsSync(distFor(v)))
  if (!chosen) {
    console.error(`✗ dist no encontrado: ${distFor('{' + entries.join(',') + '}')}`)
    process.exit(1)
  }
  return distFor(chosen)
}

const target = resolveTarget()
const src = readFileSync(target, 'utf8')

const hasMethod = src.includes('_session/steering')
// `steering: { supported: true }` — tolera un nivel de anidación y formas compiladas (`!0`).
const hasCapability = /steering[^{}]{0,60}\{[^{}]{0,120}supported[^{}]{0,60}(?:true|!0)/s.test(src)

if (hasMethod && hasCapability) {
  console.log(`✓ steering OK en ${target} (_session/steering + _meta.steering.supported)`)
  process.exit(0)
}

console.error(`✗ capability steering AUSENTE en ${target}:`)
if (!hasMethod) console.error('  - falta el método ext "_session/steering"')
if (!hasCapability) console.error('  - falta la capability initialize _meta.steering.supported = true')
console.error(`Remedio: ${REMEDY}`)
process.exit(1)
