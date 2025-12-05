# LifestyleAcademy Style Guide
## Premium Wellness & Lifestyle Medicine Design System

### Design Philosophy
**Goal**: Convey trust, expertise, and premium quality while maintaining approachability. The design should feel like a multi-million-dollar company providing the best resources in evidence-based wellness.

---

## Color Palette Options

### Option A: Natural Wellness (Recommended)
**Inspired by**: Modern wellness brands, natural medicine practices

**Primary Colors:**
- **Sage Green**: `hsl(142, 25%, 35%)` - Primary brand color, conveys growth, health, nature
- **Warm Gold**: `hsl(43, 96%, 56%)` - Accent color, premium feel, warmth
- **Forest Green**: `hsl(142, 40%, 25%)` - Darker variant for depth

**Neutral Colors:**
- **Charcoal**: `hsl(222, 20%, 15%)` - Text and dark elements
- **Warm Gray**: `hsl(30, 10%, 95%)` - Backgrounds
- **Muted Sage**: `hsl(142, 15%, 92%)` - Subtle backgrounds

**Why This Works:**
- Green is associated with health, growth, and nature
- Gold adds luxury and premium feel
- Natural, calming palette that builds trust
- Differentiates from clinical blue medical sites

---

### Option B: Modern Medical Sophistication
**Inspired by**: Peter Attia, premium medical practices

**Primary Colors:**
- **Deep Teal**: `hsl(195, 50%, 30%)` - Professional, scientific
- **Amber Gold**: `hsl(38, 90%, 55%)` - Premium accent
- **Slate Blue**: `hsl(210, 25%, 20%)` - Depth and contrast

**Neutral Colors:**
- **Charcoal**: `hsl(220, 15%, 12%)` - Text
- **Cool Gray**: `hsl(220, 10%, 96%)` - Backgrounds
- **Light Teal**: `hsl(195, 20%, 95%)` - Subtle backgrounds

**Why This Works:**
- Professional medical feel
- Modern and sophisticated
- Scientific credibility
- Premium but approachable

---

### Option C: Earthy Elegance
**Inspired by**: Functional medicine, holistic wellness

**Primary Colors:**
- **Terracotta**: `hsl(12, 45%, 45%)` - Warm, earthy primary
- **Sage Green**: `hsl(142, 25%, 40%)` - Natural accent
- **Deep Brown**: `hsl(25, 30%, 20%)` - Rich depth

**Neutral Colors:**
- **Warm Beige**: `hsl(35, 15%, 95%)` - Soft backgrounds
- **Charcoal**: `hsl(220, 15%, 15%)` - Text
- **Muted Terracotta**: `hsl(12, 20%, 92%)` - Subtle backgrounds

**Why This Works:**
- Very natural, holistic feel
- Warm and inviting
- Unique in medical space
- Connects to earth/nature

---

## Typography

### Option A: Modern Elegance (Recommended)
**Headings**: **Playfair Display** (Serif)
- Elegant, sophisticated
- Excellent for large headlines
- Conveys premium quality
- Good contrast with sans-serif body

**Body**: **Inter** or **Avenir Next**
- Clean, modern, highly readable
- Professional appearance
- Excellent for long-form content
- Avenir Next adds more premium feel

**Why This Works:**
- Serif headings add elegance and authority
- Sans-serif body ensures readability
- Classic combination used by premium brands

---

### Option B: Geometric Modern
**Headings**: **Avenir Next** or **Proxima Nova** (Geometric Sans-Serif)
- Clean, modern, geometric
- Very professional
- Excellent readability
- Contemporary feel

**Body**: **Inter** or **Avenir Next**
- Consistent with headings
- Clean and modern
- Highly readable

**Why This Works:**
- Very modern, tech-forward feel
- Consistent typography
- Used by premium tech/medical brands

---

### Option C: Classic Medical
**Headings**: **Merriweather** or **Lora** (Traditional Serif)
- Trustworthy, established feel
- Medical/clinical associations
- Excellent readability
- Professional authority

**Body**: **Source Sans Pro** or **Open Sans**
- Clean, approachable
- Excellent readability
- Widely used in healthcare

**Why This Works:**
- Traditional medical feel
- Builds trust through familiarity
- Very readable

---

## Design Principles

### 1. Generous White Space
- Ample padding and margins
- Breathing room between sections
- Premium, uncluttered feel
- Focus on content hierarchy

### 2. Subtle Depth & Shadows
- Soft shadows for cards (`shadow-premium`)
- Layered depth without being heavy
- Creates visual interest
- Premium, polished appearance

### 3. Natural Elements
- Consider subtle nature imagery
- Organic shapes and curves
- Connection to wellness/nature
- Avoid clinical sterility

### 4. Smooth Interactions
- Subtle hover effects
- Smooth transitions (200-300ms)
- Micro-interactions that delight
- Professional polish

### 5. Visual Hierarchy
- Clear heading structure
- Generous spacing
- Strategic use of color
- Easy to scan and digest

---

## Component Patterns

### Buttons
- **Primary**: Full color background, white text, hover lift effect
- **Secondary**: Outlined, transparent background, hover fill
- **Accent**: Gold/amber for CTAs, premium feel
- Rounded corners (6-8px)
- Generous padding (px-8 py-3.5)

### Cards
- Subtle border (`border-border/50`)
- Soft shadow (`shadow-premium`)
- Rounded corners (`rounded-lg`)
- Generous padding (`p-8`)
- Hover lift effect

### Typography Scale
- **H1**: 4xl-8xl (serif, bold)
- **H2**: 3xl-5xl (serif, semibold)
- **H3**: 2xl-3xl (serif, semibold)
- **Body**: lg-xl (sans-serif, light/regular)
- **Small**: sm-base (sans-serif, regular)

---

## Recommendations

**Recommended Combination:**
- **Color**: Option A (Natural Wellness - Sage Green + Gold)
- **Typography**: Option A (Playfair Display + Inter/Avenir)
- **Rationale**: 
  - Green conveys health and wellness naturally
  - Gold adds premium luxury feel
  - Serif headings add elegance
  - Differentiates from clinical blue medical sites
  - Warm, approachable, yet professional

---

## Implementation Notes

1. **Consistency**: Use design tokens (CSS variables) for all colors
2. **Accessibility**: Ensure WCAG AA contrast ratios
3. **Responsive**: Mobile-first approach, generous spacing on all devices
4. **Performance**: Optimize fonts (subset, display: swap)
5. **Branding**: Logo should incorporate primary color + gold accent
