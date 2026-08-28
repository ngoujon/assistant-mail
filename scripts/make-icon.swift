// Génère assets/icon-1024.png : squircle bleu encre + enveloppe + étincelles IA.
// Usage : swift scripts/make-icon.swift <chemin de sortie>

import AppKit
import CoreGraphics
import Foundation

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/icon-1024.png"

guard let ctx = CGContext(
  data: nil,
  width: Int(size),
  height: Int(size),
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: CGColorSpace(name: CGColorSpace.sRGB)!,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
  fatalError("contexte graphique indisponible")
}

ctx.setAllowsAntialiasing(true)
ctx.interpolationQuality = .high

// --- Squircle : marge façon icône macOS (le glyphe occupe ~80 % du canevas)
let inset: CGFloat = size * 0.098
let rect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let radius = rect.width * 0.2237
let squircle = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

ctx.saveGState()
ctx.addPath(squircle)
ctx.clip()
// Bleu encre : ciel en haut à gauche, profondeur en bas à droite.
let colors = [
  CGColor(red: 0.400, green: 0.678, blue: 0.949, alpha: 1),
  CGColor(red: 0.239, green: 0.435, blue: 0.949, alpha: 1),
  CGColor(red: 0.106, green: 0.176, blue: 0.510, alpha: 1),
] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                          colors: colors, locations: [0, 0.48, 1])!
ctx.drawLinearGradient(gradient,
                       start: CGPoint(x: rect.minX, y: rect.maxY),
                       end: CGPoint(x: rect.maxX, y: rect.minY),
                       options: [])

let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                      colors: [CGColor(red: 1, green: 1, blue: 1, alpha: 0.13),
                               CGColor(red: 1, green: 1, blue: 1, alpha: 0)] as CFArray,
                      locations: [0, 1])!
ctx.drawRadialGradient(glow,
                       startCenter: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.maxY - rect.height * 0.18),
                       startRadius: 0,
                       endCenter: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.maxY - rect.height * 0.18),
                       endRadius: rect.width * 0.72,
                       options: [])
ctx.restoreGState()

// --- Enveloppe blanche
let cx = size / 2
let cy = size / 2 - size * 0.012
let w = size * 0.470
let h = size * 0.330
let env = CGRect(x: cx - w / 2, y: cy - h / 2, width: w, height: h)
let trait = size * 0.062

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -size * 0.012), blur: size * 0.036,
              color: CGColor(red: 0.05, green: 0.09, blue: 0.30, alpha: 0.28))
ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.setLineWidth(trait)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.addPath(CGPath(roundedRect: env.insetBy(dx: trait / 2, dy: trait / 2),
                   cornerWidth: size * 0.052, cornerHeight: size * 0.052, transform: nil))
ctx.strokePath()

// Le rabat : deux droites qui plongent vers le centre.
ctx.move(to: CGPoint(x: env.minX + trait * 1.05, y: env.maxY - trait * 1.15))
ctx.addLine(to: CGPoint(x: cx, y: cy + h * 0.055))
ctx.addLine(to: CGPoint(x: env.maxX - trait * 1.05, y: env.maxY - trait * 1.15))
ctx.strokePath()
ctx.restoreGState()

// --- Étincelle (le côté « assistant »)
func sparkle(at center: CGPoint, radius r: CGFloat, alpha: CGFloat) {
  let waist = r * 0.30
  let path = CGMutablePath()
  path.move(to: CGPoint(x: center.x, y: center.y + r))
  path.addQuadCurve(to: CGPoint(x: center.x + r, y: center.y),
                    control: CGPoint(x: center.x + waist, y: center.y + waist))
  path.addQuadCurve(to: CGPoint(x: center.x, y: center.y - r),
                    control: CGPoint(x: center.x + waist, y: center.y - waist))
  path.addQuadCurve(to: CGPoint(x: center.x - r, y: center.y),
                    control: CGPoint(x: center.x - waist, y: center.y - waist))
  path.addQuadCurve(to: CGPoint(x: center.x, y: center.y + r),
                    control: CGPoint(x: center.x - waist, y: center.y + waist))
  path.closeSubpath()
  ctx.addPath(path)
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: alpha))
  ctx.fillPath()
}

sparkle(at: CGPoint(x: cx + size * 0.258, y: cy + size * 0.243), radius: size * 0.068, alpha: 0.97)
sparkle(at: CGPoint(x: cx + size * 0.350, y: cy + size * 0.138), radius: size * 0.031, alpha: 0.76)

// --- Écriture du PNG
guard let image = ctx.makeImage() else { fatalError("rendu impossible") }
let rep = NSBitmapImageRep(cgImage: image)
rep.size = NSSize(width: size, height: size)
guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("encodage PNG impossible") }
try data.write(to: URL(fileURLWithPath: out))
print("icône écrite : \(out)")
