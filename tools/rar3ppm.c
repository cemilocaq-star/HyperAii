/* Developer utility (NOT runtime): decoder for ONE RAR 2.9/3.x (RAR4 container) file whose block is PPMd var.H.
 * Written because the system libarchive mis-decodes IronMan.obj (drops bytes, then fails at 14 MiB).
 * Model = PPMd7 (var.H, the 7-Zip/unrar model); range coder = the RAR3 variant; escape codes 0/2/3/4/5 as in unrar.
 * LZ blocks and VM filters (escape 3) are NOT implemented: the tool stops with an explicit error instead of guessing.
 * Usage: rar3ppm packed.bin UNPACKED_SIZE out.bin     (prints "crc32=XXXXXXXX produced=N status=...")            */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

typedef uint8_t Byte; typedef uint16_t UInt16; typedef uint32_t UInt32; typedef int32_t Int32;
#define UNIT_SIZE 12
#define MAX_FREQ 124
#define PPMD_INT_BITS 7
#define PPMD_PERIOD_BITS 7
#define PPMD_BIN_SCALE (1 << (PPMD_INT_BITS + PPMD_PERIOD_BITS))
#define PPMD_GET_MEAN_SPEC(summ, shift, round) (((summ) + (1 << ((shift) - 2))) >> (shift))
#define PPMD_GET_MEAN(prob) PPMD_GET_MEAN_SPEC((prob), PPMD_PERIOD_BITS, 2)
#define PPMD_UPDATE_PROB_0(prob) ((prob) + (1 << PPMD_INT_BITS) - PPMD_GET_MEAN(prob))
#define PPMD_UPDATE_PROB_1(prob) ((prob) - PPMD_GET_MEAN(prob))
#define PPMD_N1 4
#define PPMD_N2 4
#define PPMD_N3 4
#define PPMD_N4 ((128 + 3 - 1 * PPMD_N1 - 2 * PPMD_N2 - 3 * PPMD_N3) / 4)
#define PPMD_NUM_INDEXES (PPMD_N1 + PPMD_N2 + PPMD_N3 + PPMD_N4)
#define PPMD7_MAX_ORDER 64

#pragma pack(push, 1)
typedef struct { UInt16 Summ; Byte Shift; Byte Count; } CPpmd_See;
typedef struct { Byte Symbol; Byte Freq; UInt16 SuccessorLow; UInt16 SuccessorHigh; } CPpmd_State;
typedef struct { UInt16 NumStats; UInt16 SummFreq; UInt32 Stats; UInt32 Suffix; } CPpmd7_Context;
typedef struct { UInt16 Stamp; UInt16 NU; UInt32 Next; UInt32 Prev; } CPpmd7_Node;
#pragma pack(pop)
#define Ppmd_See_Update(p) if ((p)->Shift < PPMD_PERIOD_BITS && --(p)->Count == 0) { (p)->Summ <<= 1; (p)->Count = (Byte)(3 << (p)->Shift++); }

typedef struct {
  CPpmd7_Context *MinContext, *MaxContext; CPpmd_State *FoundState;
  unsigned OrderFall, InitEsc, PrevSuccess, MaxOrder, HiBitsFlag; Int32 RunLength, InitRL;
  UInt32 Size, GlueCount; Byte *Base, *LoUnit, *HiUnit, *Text, *UnitsStart; UInt32 AlignOffset;
  Byte Indx2Units[PPMD_NUM_INDEXES], Units2Indx[128]; UInt32 FreeList[PPMD_NUM_INDEXES];
  Byte NS2Indx[256], NS2BSIndx[256], HB2Flag[256]; CPpmd_See DummySee, See[25][16]; UInt16 BinSumm[128][64];
} CPpmd7;

static const Byte kExpEscape[16] = { 25, 14, 9, 7, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2 };
static const UInt16 kInitBinEsc[] = { 0x3CDD, 0x1F3F, 0x59BF, 0x48F3, 0x64A1, 0x5ABC, 0x6632, 0x6051 };

#define U2B(nu) ((UInt32)(nu) * UNIT_SIZE)
#define U2I(nu) (p->Units2Indx[(nu) - 1])
#define I2U(indx) (p->Indx2Units[indx])
#define PTR(ref) ((void *)(p->Base + (ref)))
#define REF(ptr) ((UInt32)((Byte *)(ptr) - p->Base))
#define CTX(ref) ((CPpmd7_Context *)PTR(ref))
#define NODE(ref) ((CPpmd7_Node *)PTR(ref))
#define STATS(ctx) ((CPpmd_State *)PTR((ctx)->Stats))
#define ONE_STATE(ctx) ((CPpmd_State *)&(ctx)->SummFreq)
#define SUFFIX(ctx) CTX((ctx)->Suffix)
#define SUCCESSOR(s) ((UInt32)((s)->SuccessorLow | ((UInt32)(s)->SuccessorHigh << 16)))
static void SetSuccessor(CPpmd_State *s, UInt32 v) { s->SuccessorLow = (UInt16)(v & 0xFFFF); s->SuccessorHigh = (UInt16)((v >> 16) & 0xFFFF); }

static void Construct(CPpmd7 *p) {
  unsigned i, k, m; p->Base = 0;
  for (i = 0, k = 0; i < PPMD_NUM_INDEXES; i++) { unsigned step = (i >= 12 ? 4 : (i >> 2) + 1); do { p->Units2Indx[k++] = (Byte)i; } while (--step); p->Indx2Units[i] = (Byte)k; }
  p->NS2BSIndx[0] = (0 << 1); p->NS2BSIndx[1] = (1 << 1); memset(p->NS2BSIndx + 2, (2 << 1), 9); memset(p->NS2BSIndx + 11, (3 << 1), 256 - 11);
  for (i = 0; i < 3; i++) p->NS2Indx[i] = (Byte)i;
  for (m = i, k = 1; i < 256; i++) { p->NS2Indx[i] = (Byte)m; if (--k == 0) k = (++m) - 2; }
  memset(p->HB2Flag, 0, 0x40); memset(p->HB2Flag + 0x40, 8, 0x100 - 0x40);
}
static int Alloc(CPpmd7 *p, UInt32 size) {
  p->AlignOffset = 4 - (size & 3);
  p->Base = (Byte *)calloc(1, (size_t)p->AlignOffset + size + UNIT_SIZE * 4);
  p->Size = size; return p->Base != 0;
}
static void InsertNode(CPpmd7 *p, void *node, unsigned indx) { *((UInt32 *)node) = p->FreeList[indx]; p->FreeList[indx] = REF(node); }
static void *RemoveNode(CPpmd7 *p, unsigned indx) { UInt32 *node = (UInt32 *)PTR(p->FreeList[indx]); p->FreeList[indx] = *node; return node; }
static void SplitBlock(CPpmd7 *p, void *ptr, unsigned oldIndx, unsigned newIndx) {
  unsigned i, nu = I2U(oldIndx) - I2U(newIndx);
  ptr = (Byte *)ptr + U2B(I2U(newIndx));
  if (I2U(i = U2I(nu)) != nu) { unsigned k = I2U(--i); InsertNode(p, ((Byte *)ptr) + U2B(k), nu - k - 1); }
  InsertNode(p, ptr, i);
}
static void GlueFreeBlocks(CPpmd7 *p) {
  UInt32 head = p->AlignOffset + p->Size; UInt32 n = head; unsigned i;
  p->GlueCount = 255;
  for (i = 0; i < PPMD_NUM_INDEXES; i++) {
    UInt16 nu = I2U(i); UInt32 next = p->FreeList[i]; p->FreeList[i] = 0;
    while (next != 0) {
      CPpmd7_Node *node = NODE(next);
      node->Next = n; n = NODE(n)->Prev = next;
      next = *(const UInt32 *)node; node->Stamp = 0; node->NU = nu;
    }
  }
  NODE(head)->Stamp = 1; NODE(head)->Next = n; NODE(n)->Prev = head;
  if (p->LoUnit != p->HiUnit) ((CPpmd7_Node *)p->LoUnit)->Stamp = 1;
  while (n != head) {
    CPpmd7_Node *node = NODE(n); UInt32 nu = (UInt32)node->NU;
    for (;;) {
      CPpmd7_Node *node2 = NODE(n) + nu; nu += node2->NU;
      if (node2->Stamp != 0 || nu >= 0x10000) break;
      NODE(node2->Prev)->Next = node2->Next; NODE(node2->Next)->Prev = node2->Prev; node->NU = (UInt16)nu;
    }
    n = node->Next;
  }
  for (n = NODE(head)->Next; n != head;) {
    CPpmd7_Node *node = NODE(n); unsigned nu; UInt32 next = node->Next;
    for (nu = node->NU; nu > 128; nu -= 128, node += 128) InsertNode(p, node, PPMD_NUM_INDEXES - 1);
    if (I2U(i = U2I(nu)) != nu) { unsigned k = I2U(--i); InsertNode(p, node + k, nu - k - 1); }
    InsertNode(p, node, i); n = next;
  }
}
static void *AllocUnitsRare(CPpmd7 *p, unsigned indx) {
  unsigned i; void *retVal;
  if (p->GlueCount == 0) { GlueFreeBlocks(p); if (p->FreeList[indx] != 0) return RemoveNode(p, indx); }
  i = indx;
  do {
    if (++i == PPMD_NUM_INDEXES) { UInt32 numBytes = U2B(I2U(indx)); p->GlueCount--; return ((UInt32)(p->UnitsStart - p->Text) > numBytes) ? (p->UnitsStart -= numBytes) : (NULL); }
  } while (p->FreeList[i] == 0);
  retVal = RemoveNode(p, i); SplitBlock(p, retVal, i, indx); return retVal;
}
static void *AllocUnits(CPpmd7 *p, unsigned indx) {
  UInt32 numBytes;
  if (p->FreeList[indx] != 0) return RemoveNode(p, indx);
  numBytes = U2B(I2U(indx));
  if (numBytes <= (UInt32)(p->HiUnit - p->LoUnit)) { void *r = p->LoUnit; p->LoUnit += numBytes; return r; }
  return AllocUnitsRare(p, indx);
}
#define MyMem12Cpy(dest, src, num) { UInt32 *d = (UInt32 *)(dest); const UInt32 *s = (const UInt32 *)(src); UInt32 n = (num); do { d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; s += 3; d += 3; } while (--n); }
static void *ShrinkUnits(CPpmd7 *p, void *oldPtr, unsigned oldNU, unsigned newNU) {
  unsigned i0 = U2I(oldNU), i1 = U2I(newNU);
  if (i0 == i1) return oldPtr;
  if (p->FreeList[i1] != 0) { void *ptr = RemoveNode(p, i1); MyMem12Cpy(ptr, oldPtr, newNU); InsertNode(p, oldPtr, i0); return ptr; }
  SplitBlock(p, oldPtr, i0, i1); return oldPtr;
}
static void RestartModel(CPpmd7 *p) {
  unsigned i, k, m;
  memset(p->FreeList, 0, sizeof(p->FreeList));
  p->Text = p->Base + p->AlignOffset; p->HiUnit = p->Text + p->Size;
  p->LoUnit = p->UnitsStart = p->HiUnit - p->Size / 8 / UNIT_SIZE * 7 * UNIT_SIZE; p->GlueCount = 0;
  p->OrderFall = p->MaxOrder; p->RunLength = p->InitRL = -(Int32)((p->MaxOrder < 12) ? p->MaxOrder : 12) - 1; p->PrevSuccess = 0;
  p->MinContext = p->MaxContext = (CPpmd7_Context *)(p->HiUnit -= UNIT_SIZE);
  p->MinContext->Suffix = 0; p->MinContext->NumStats = 256; p->MinContext->SummFreq = 256 + 1;
  p->FoundState = (CPpmd_State *)p->LoUnit; p->LoUnit += U2B(256 / 2); p->MinContext->Stats = REF(p->FoundState);
  for (i = 0; i < 256; i++) { CPpmd_State *s = &p->FoundState[i]; s->Symbol = (Byte)i; s->Freq = 1; SetSuccessor(s, 0); }
  for (i = 0; i < 128; i++) for (k = 0; k < 8; k++) { UInt16 *dest = p->BinSumm[i] + k; UInt16 val = (UInt16)(PPMD_BIN_SCALE - kInitBinEsc[k] / (i + 2)); for (m = 0; m < 64; m += 8) dest[m] = val; }
  for (i = 0; i < 25; i++) for (k = 0; k < 16; k++) { CPpmd_See *s = &p->See[i][k]; s->Summ = (UInt16)((5 * i + 10) << (s->Shift = PPMD_PERIOD_BITS - 4)); s->Count = 4; }
}
static void Init(CPpmd7 *p, unsigned maxOrder) { p->MaxOrder = maxOrder; RestartModel(p); p->DummySee.Shift = PPMD_PERIOD_BITS; p->DummySee.Summ = 0; p->DummySee.Count = 64; }

static CPpmd7_Context *CreateSuccessors(CPpmd7 *p, int skip) {
  CPpmd_State upState; CPpmd7_Context *c = p->MinContext; UInt32 upBranch = SUCCESSOR(p->FoundState);
  CPpmd_State *ps[PPMD7_MAX_ORDER]; unsigned numPs = 0;
  if (!skip) ps[numPs++] = p->FoundState;
  while (c->Suffix) {
    UInt32 successor; CPpmd_State *s; c = SUFFIX(c);
    if (c->NumStats != 1) { for (s = STATS(c); s->Symbol != p->FoundState->Symbol; s++); } else s = ONE_STATE(c);
    successor = SUCCESSOR(s);
    if (successor != upBranch) { c = CTX(successor); if (numPs == 0) return c; break; }
    ps[numPs++] = s;
  }
  upState.Symbol = *(const Byte *)PTR(upBranch); SetSuccessor(&upState, upBranch + 1);
  if (c->NumStats == 1) upState.Freq = ONE_STATE(c)->Freq;
  else {
    UInt32 cf, s0; CPpmd_State *s;
    for (s = STATS(c); s->Symbol != upState.Symbol; s++);
    cf = s->Freq - 1; s0 = c->SummFreq - c->NumStats - cf;
    upState.Freq = (Byte)(1 + ((2 * cf <= s0) ? (5 * cf > s0) : ((2 * cf + 3 * s0 - 1) / (2 * s0))));
  }
  do {
    CPpmd7_Context *c1;
    if (p->HiUnit != p->LoUnit) c1 = (CPpmd7_Context *)(p->HiUnit -= UNIT_SIZE);
    else if (p->FreeList[0] != 0) c1 = (CPpmd7_Context *)RemoveNode(p, 0);
    else { c1 = (CPpmd7_Context *)AllocUnitsRare(p, 0); if (!c1) return NULL; }
    c1->NumStats = 1; *ONE_STATE(c1) = upState; c1->Suffix = REF(c); SetSuccessor(ps[--numPs], REF(c1)); c = c1;
  } while (numPs != 0);
  return c;
}
static void SwapStates(CPpmd_State *t1, CPpmd_State *t2) { CPpmd_State tmp = *t1; *t1 = *t2; *t2 = tmp; }
static void UpdateModel(CPpmd7 *p) {
  UInt32 successor, fSuccessor = SUCCESSOR(p->FoundState); CPpmd7_Context *c; unsigned s0, ns;
  if (p->FoundState->Freq < MAX_FREQ / 4 && p->MinContext->Suffix != 0) {
    c = SUFFIX(p->MinContext);
    if (c->NumStats == 1) { CPpmd_State *s = ONE_STATE(c); if (s->Freq < 32) s->Freq++; }
    else {
      CPpmd_State *s = STATS(c);
      if (s->Symbol != p->FoundState->Symbol) { do { s++; } while (s->Symbol != p->FoundState->Symbol); if (s[0].Freq >= s[-1].Freq) { SwapStates(&s[0], &s[-1]); s--; } }
      if (s->Freq < MAX_FREQ - 9) { s->Freq += 2; c->SummFreq += 2; }
    }
  }
  if (p->OrderFall == 0) {
    p->MinContext = p->MaxContext = CreateSuccessors(p, 1);
    if (p->MinContext == 0) { RestartModel(p); return; }
    SetSuccessor(p->FoundState, REF(p->MinContext)); return;
  }
  *p->Text++ = p->FoundState->Symbol; successor = REF(p->Text);
  if (p->Text >= p->UnitsStart) { RestartModel(p); return; }
  if (fSuccessor) {
    if (fSuccessor <= successor) {
      CPpmd7_Context *cs = CreateSuccessors(p, 0);
      if (cs == NULL) { RestartModel(p); return; }
      fSuccessor = REF(cs);
    }
    if (--p->OrderFall == 0) { successor = fSuccessor; p->Text -= (p->MaxContext != p->MinContext); }
  } else { SetSuccessor(p->FoundState, successor); fSuccessor = REF(p->MinContext); }
  s0 = p->MinContext->SummFreq - (ns = p->MinContext->NumStats) - (p->FoundState->Freq - 1);
  for (c = p->MaxContext; c != p->MinContext; c = SUFFIX(c)) {
    unsigned ns1; UInt32 cf, sf;
    if ((ns1 = c->NumStats) != 1) {
      if ((ns1 & 1) == 0) {
        unsigned oldNU = ns1 >> 1; unsigned i = U2I(oldNU);
        if (i != U2I(oldNU + 1)) {
          void *ptr = AllocUnits(p, i + 1); void *oldPtr;
          if (!ptr) { RestartModel(p); return; }
          oldPtr = STATS(c); MyMem12Cpy(ptr, oldPtr, oldNU); InsertNode(p, oldPtr, i); c->Stats = REF(ptr);
        }
      }
      c->SummFreq = (UInt16)(c->SummFreq + (2 * ns1 < ns) + 2 * ((4 * ns1 <= ns) & (c->SummFreq <= 8 * ns1)));
    } else {
      CPpmd_State *s = (CPpmd_State *)AllocUnits(p, 0);
      if (!s) { RestartModel(p); return; }
      *s = *ONE_STATE(c); c->Stats = REF(s);
      if (s->Freq < MAX_FREQ / 4 - 1) s->Freq <<= 1; else s->Freq = MAX_FREQ - 4;
      c->SummFreq = (UInt16)(s->Freq + p->InitEsc + (ns > 3));
    }
    cf = 2 * (UInt32)p->FoundState->Freq * (c->SummFreq + 6); sf = (UInt32)s0 + c->SummFreq;
    if (cf < 6 * sf) { cf = 1 + (cf > sf) + (cf >= 4 * sf); c->SummFreq += 3; }
    else { cf = 4 + (cf >= 9 * sf) + (cf >= 12 * sf) + (cf >= 15 * sf); c->SummFreq = (UInt16)(c->SummFreq + cf); }
    { CPpmd_State *s = STATS(c) + ns1; SetSuccessor(s, successor); s->Symbol = p->FoundState->Symbol; s->Freq = (Byte)cf; c->NumStats = (UInt16)(ns1 + 1); }
  }
  p->MaxContext = p->MinContext = CTX(fSuccessor);
}
static void Rescale(CPpmd7 *p) {
  unsigned i, adder, sumFreq, escFreq; CPpmd_State *stats = STATS(p->MinContext); CPpmd_State *s = p->FoundState;
  if (s != stats) { CPpmd_State tmp = *s; do s[0] = s[-1]; while (--s != stats); *s = tmp; }
  escFreq = p->MinContext->SummFreq - s->Freq; s->Freq += 4; adder = (p->OrderFall != 0);
  s->Freq = (Byte)((s->Freq + adder) >> 1); sumFreq = s->Freq;
  i = p->MinContext->NumStats - 1;
  do {
    escFreq -= (++s)->Freq; s->Freq = (Byte)((s->Freq + adder) >> 1); sumFreq += s->Freq;
    if (s[0].Freq > s[-1].Freq) { CPpmd_State *s1 = s; CPpmd_State tmp = *s1; do s1[0] = s1[-1]; while (--s1 != stats && tmp.Freq > s1[-1].Freq); *s1 = tmp; }
  } while (--i);
  if (s->Freq == 0) {
    unsigned numStats = p->MinContext->NumStats; unsigned n0, n1;
    do { i++; } while ((--s)->Freq == 0);
    escFreq += i; p->MinContext->NumStats = (UInt16)(p->MinContext->NumStats - i);
    if (p->MinContext->NumStats == 1) {
      CPpmd_State tmp = *stats;
      do { tmp.Freq = (Byte)(tmp.Freq - (tmp.Freq >> 1)); escFreq >>= 1; } while (escFreq > 1);
      InsertNode(p, stats, U2I(((numStats + 1) >> 1)));
      *(p->FoundState = ONE_STATE(p->MinContext)) = tmp; return;
    }
    n0 = (numStats + 1) >> 1; n1 = (p->MinContext->NumStats + 1) >> 1;
    if (n0 != n1) p->MinContext->Stats = REF(ShrinkUnits(p, stats, n0, n1));
  }
  p->MinContext->SummFreq = (UInt16)(sumFreq + escFreq - (escFreq >> 1)); p->FoundState = STATS(p->MinContext);
}
static CPpmd_See *MakeEscFreq(CPpmd7 *p, unsigned numMasked, UInt32 *escFreq) {
  CPpmd_See *see; unsigned nonMasked = p->MinContext->NumStats - numMasked;
  if (p->MinContext->NumStats != 256) {
    see = p->See[p->NS2Indx[nonMasked - 1]] + (nonMasked < (unsigned)SUFFIX(p->MinContext)->NumStats - p->MinContext->NumStats) + 2 * (p->MinContext->SummFreq < 11 * p->MinContext->NumStats) + 4 * (numMasked > nonMasked) + p->HiBitsFlag;
    { unsigned r = (see->Summ >> see->Shift); see->Summ = (UInt16)(see->Summ - r); *escFreq = r + (r == 0); }
  } else { see = &p->DummySee; *escFreq = 1; }
  return see;
}
static void NextContext(CPpmd7 *p) {
  CPpmd7_Context *c = CTX(SUCCESSOR(p->FoundState));
  if (p->OrderFall == 0 && (Byte *)c > p->Text) p->MinContext = p->MaxContext = c; else UpdateModel(p);
}
static void Update1(CPpmd7 *p) {
  CPpmd_State *s = p->FoundState; s->Freq += 4; p->MinContext->SummFreq += 4;
  if (s[0].Freq > s[-1].Freq) { SwapStates(&s[0], &s[-1]); p->FoundState = --s; if (s->Freq > MAX_FREQ) Rescale(p); }
  NextContext(p);
}
static void Update1_0(CPpmd7 *p) {
  p->PrevSuccess = (2 * p->FoundState->Freq > p->MinContext->SummFreq); p->RunLength += p->PrevSuccess; p->MinContext->SummFreq += 4;
  if ((p->FoundState->Freq += 4) > MAX_FREQ) Rescale(p);
  NextContext(p);
}
static void UpdateBin(CPpmd7 *p) {
  p->FoundState->Freq = (Byte)(p->FoundState->Freq + (p->FoundState->Freq < 128 ? 1 : 0)); p->PrevSuccess = 1; p->RunLength++; NextContext(p);
}
static void Update2(CPpmd7 *p) {
  p->MinContext->SummFreq += 4;
  if ((p->FoundState->Freq += 4) > MAX_FREQ) Rescale(p);
  p->RunLength = p->InitRL; UpdateModel(p);
}

/* ---- RAR3 range decoder ---- */
typedef struct { const Byte *in; size_t pos, len; UInt32 Range, Code, Low; int overrun; } RC;
static Byte rc_byte(RC *r) { if (r->pos < r->len) return r->in[r->pos++]; r->overrun = 1; return 0; }
static void rc_init(RC *r) { int i; r->Code = 0; r->Low = 0; r->Range = 0xFFFFFFFF; for (i = 0; i < 4; i++) r->Code = (r->Code << 8) | rc_byte(r); }
static void rc_norm(RC *r) {
  for (;;) {
    if ((r->Low ^ (r->Low + r->Range)) >= (1u << 24)) { if (r->Range >= (1u << 15)) break; r->Range = (0 - r->Low) & ((1u << 15) - 1); }
    r->Code = (r->Code << 8) | rc_byte(r); r->Range <<= 8; r->Low <<= 8;
  }
}
static UInt32 rc_thr(RC *r, UInt32 total) { return (r->Code - r->Low) / (r->Range /= total); }
static void rc_dec(RC *r, UInt32 start, UInt32 size) { r->Low += start * r->Range; r->Range *= size; rc_norm(r); }
static UInt32 rc_bit(RC *r, UInt32 size0, UInt32 total) {
  /* unrar semantics (RAR3): Range is divided first, BOTH branches multiply by the divided Range (no remainder is kept) */
  UInt32 R = r->Range / total, count = (r->Code - r->Low) / R, sym;
  if (count < size0) { sym = 0; r->Range = R * size0; }
  else { sym = 1; r->Low += R * size0; r->Range = R * (total - size0); }
  rc_norm(r); return sym;
}
#define MASK(sym) ((signed char *)charMask)[sym]
static int DecodeSymbol(CPpmd7 *p, RC *rc) {
  size_t charMask[256 / sizeof(size_t)];
  if (p->MinContext->NumStats != 1) {
    CPpmd_State *s = STATS(p->MinContext); unsigned i; UInt32 count, hiCnt;
    if ((count = rc_thr(rc, p->MinContext->SummFreq)) < (hiCnt = s->Freq)) {
      Byte symbol; rc_dec(rc, 0, s->Freq); p->FoundState = s; symbol = s->Symbol; Update1_0(p); return symbol;
    }
    p->PrevSuccess = 0; i = p->MinContext->NumStats - 1;
    do {
      if ((hiCnt += (++s)->Freq) > count) { Byte symbol; rc_dec(rc, hiCnt - s->Freq, s->Freq); p->FoundState = s; symbol = s->Symbol; Update1(p); return symbol; }
    } while (--i);
    if (count >= p->MinContext->SummFreq) return -2;
    p->HiBitsFlag = p->HB2Flag[p->FoundState->Symbol];
    rc_dec(rc, hiCnt, p->MinContext->SummFreq - hiCnt);
    memset(charMask, 0xFF, sizeof(charMask)); MASK(s->Symbol) = 0; i = p->MinContext->NumStats - 1;
    do { MASK((--s)->Symbol) = 0; } while (--i);
  } else {
    UInt16 *prob = &p->BinSumm[ONE_STATE(p->MinContext)->Freq - 1][p->PrevSuccess + p->NS2BSIndx[SUFFIX(p->MinContext)->NumStats - 1] + (p->HiBitsFlag = p->HB2Flag[p->FoundState->Symbol]) + 2 * p->HB2Flag[ONE_STATE(p->MinContext)->Symbol] + ((p->RunLength >> 26) & 0x20)];
    if (rc_bit(rc, *prob, PPMD_BIN_SCALE) == 0) {
      Byte symbol; *prob = (UInt16)PPMD_UPDATE_PROB_0(*prob); symbol = (p->FoundState = ONE_STATE(p->MinContext))->Symbol; UpdateBin(p); return symbol;
    }
    *prob = (UInt16)PPMD_UPDATE_PROB_1(*prob); p->InitEsc = kExpEscape[*prob >> 10];
    memset(charMask, 0xFF, sizeof(charMask)); MASK(ONE_STATE(p->MinContext)->Symbol) = 0; p->PrevSuccess = 0;
  }
  for (;;) {
    CPpmd_State *ps[256], *s; UInt32 freqSum, count, hiCnt; CPpmd_See *see; unsigned i, num, numMasked = p->MinContext->NumStats;
    do {
      p->OrderFall++;
      if (!p->MinContext->Suffix) return -1;
      p->MinContext = SUFFIX(p->MinContext);
    } while (p->MinContext->NumStats == numMasked);
    hiCnt = 0; s = STATS(p->MinContext); i = 0; num = p->MinContext->NumStats - numMasked;
    do { int k = (int)(MASK(s->Symbol)); hiCnt += (s->Freq & k); ps[i] = s++; i -= k; } while (i != num);
    see = MakeEscFreq(p, numMasked, &freqSum); freqSum += hiCnt; count = rc_thr(rc, freqSum);
    if (count < hiCnt) {
      Byte symbol; CPpmd_State **pps = ps;
      for (hiCnt = 0; (hiCnt += (*pps)->Freq) <= count; pps++);
      s = *pps; rc_dec(rc, hiCnt - s->Freq, s->Freq); Ppmd_See_Update(see); p->FoundState = s; symbol = s->Symbol; Update2(p); return symbol;
    }
    if (count >= freqSum) return -2;
    rc_dec(rc, hiCnt, freqSum - hiCnt); see->Summ = (UInt16)(see->Summ + freqSum);
    do { MASK(ps[--i]->Symbol) = 0; } while (i != 0);
  }
}
static UInt32 crc_table[256];
static void crc_init(void) { for (UInt32 i = 0; i < 256; i++) { UInt32 c = i; for (int k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0xEDB88320u : c >> 1; crc_table[i] = c; } }
static UInt32 crc32(const Byte *b, size_t n) { UInt32 c = 0xFFFFFFFFu; for (size_t i = 0; i < n; i++) c = crc_table[(c ^ b[i]) & 0xFF] ^ (c >> 8); return ~c; }


/* ---------------- RAR3 LZ block (Huffman) ---------------- */
static const Byte LBits[28] = {0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5};
static const int LBase[28] = {0,1,2,3,4,5,6,7,8,10,12,14,16,20,24,28,32,40,48,56,64,80,96,112,128,160,192,224};
static UInt32 DBase[60]; static Byte DBits[60];
static const int SDBase[8] = {0,4,8,16,32,64,128,192}; static const Byte SDBits[8] = {2,2,3,4,5,6,6,6};
static void init_dtables(void) {
  static const Byte bits[60] = {0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,14,14,15,15,16,16,16,16,16,16,16,16,16,16,16,16,16,16,18,18,18,18,18,18,18,18,18,18,18,18};
  UInt32 d = 0; for (int i = 0; i < 60; i++) { DBits[i] = bits[i]; DBase[i] = d; d += 1u << bits[i]; }
}
typedef struct { int count[16]; int first[16]; int off[16]; UInt16 sym[512]; int n; } Huff;
static void huff_make(Huff *h, const Byte *len, int n) {
  int i, l; memset(h, 0, sizeof(*h)); h->n = n;
  for (i = 0; i < n; i++) h->count[len[i]]++;
  h->count[0] = 0; int code = 0, idx = 0;
  for (l = 1; l < 16; l++) { code = (code + h->count[l - 1]) << 1; h->first[l] = code; h->off[l] = idx; idx += h->count[l]; }
  int pos[16]; for (l = 1; l < 16; l++) pos[l] = h->off[l];
  for (i = 0; i < n; i++) if (len[i]) h->sym[pos[len[i]]++] = (UInt16)i;
}
typedef struct { const Byte *in; size_t len; size_t bit; int overrun; } BR;
static unsigned br_peek16(BR *b) {
  size_t byte = b->bit >> 3; unsigned sh = (unsigned)(b->bit & 7); UInt32 v = 0;
  for (int i = 0; i < 3; i++) { Byte c = (byte + i < b->len) ? b->in[byte + i] : 0; v = (v << 8) | c; }
  if (byte >= b->len + 4) b->overrun = 1;
  return (v >> (8 - sh)) & 0xFFFF;
}
static void br_skip(BR *b, unsigned n) { b->bit += n; }
static int huff_dec(Huff *h, BR *b) {
  unsigned v = br_peek16(b); int code = 0;
  for (int l = 1; l < 16; l++) {
    code = (code << 1) | ((v >> (15 - (l - 1))) & 1);
    if (h->count[l] && code - h->first[l] >= 0 && code - h->first[l] < h->count[l]) { br_skip(b, l); return h->sym[h->off[l] + code - h->first[l]]; }
  }
  b->overrun = 1; return -1;
}
typedef struct { Byte old[404]; Huff LD, DD, LDD, RD; UInt32 oldDist[4]; UInt32 lastLength; int lowDistRep; UInt32 prevLowDist; } LZ;
static int lz_read_tables(LZ *z, BR *b, int keep) {
  Byte bl[20], tbl[404]; int i; Huff BD;
  if (!keep) memset(z->old, 0, sizeof(z->old));
  for (i = 0; i < 20; i++) {
    int L = br_peek16(b) >> 12; br_skip(b, 4);
    if (L == 15) { int zc = br_peek16(b) >> 12; br_skip(b, 4); if (zc == 0) bl[i] = 15; else { zc += 2; while (zc-- > 0 && i < 20) bl[i++] = 0; i--; } }
    else bl[i] = (Byte)L;
  }
  huff_make(&BD, bl, 20);
  for (i = 0; i < 404;) {
    int num = huff_dec(&BD, b); if (num < 0) return 0;
    if (num < 16) { tbl[i] = (Byte)((num + z->old[i]) & 0xF); i++; }
    else if (num < 18) {
      int n; if (num == 16) { n = (br_peek16(b) >> 13) + 3; br_skip(b, 3); } else { n = (br_peek16(b) >> 9) + 11; br_skip(b, 7); }
      if (i == 0) return 0; while (n-- > 0 && i < 404) { tbl[i] = tbl[i - 1]; i++; }
    } else {
      int n; if (num == 18) { n = (br_peek16(b) >> 13) + 3; br_skip(b, 3); } else { n = (br_peek16(b) >> 9) + 11; br_skip(b, 7); }
      while (n-- > 0 && i < 404) tbl[i++] = 0;
    }
  }
  huff_make(&z->LD, tbl, 299); huff_make(&z->DD, tbl + 299, 60); huff_make(&z->LDD, tbl + 359, 17); huff_make(&z->RD, tbl + 376, 28);
  memcpy(z->old, tbl, 404); return 1;
}
static void copy_str(Byte *out, size_t *op, size_t unp, UInt32 len, UInt32 dist) { while (len-- && *op < unp) { out[*op] = out[*op - dist]; (*op)++; } }

/* ---------------- RAR3 VM filters (standard programs recognised by length+CRC, as unrar does) ---------------- */
enum { F_NONE = 0, F_E8, F_E8E9, F_ITANIUM, F_RGB, F_AUDIO, F_DELTA };
typedef struct { int type; UInt32 oldLen; } FilterDef;
typedef struct { size_t start; UInt32 len; int type; UInt32 R[7]; } FilterRun;
#define MAXF 8192
static FilterDef fdefs[1024]; static int nfdefs = 0, lastFilter = 0; static FilterRun *fruns; static size_t nfruns = 0;
static const char *ftype_name[] = { "NONE", "E8", "E8E9", "ITANIUM", "RGB", "AUDIO", "DELTA" };
static UInt32 vm_readdata(BR *b) {
  UInt32 d = br_peek16(b);
  switch (d & 0xC000) {
    case 0: br_skip(b, 6); return (d >> 10) & 0xF;
    case 0x4000: if ((d & 0x3C00) == 0) { d = 0xFFFFFF00u | ((d >> 2) & 0xFF); br_skip(b, 14); } else { d = (d >> 6) & 0xFF; br_skip(b, 10); } return d;
    case 0x8000: br_skip(b, 2); d = br_peek16(b); br_skip(b, 16); return d;
    default: br_skip(b, 2); d = br_peek16(b) << 16; br_skip(b, 16); d |= br_peek16(b); br_skip(b, 16); return d;
  }
}
static int ident_filter(const Byte *code, UInt32 n) {
  Byte x = 0; for (UInt32 i = 1; i < n; i++) x ^= code[i]; if (x != code[0]) return -1;
  UInt32 c = crc32(code, n);
  if (n == 53 && c == 0xad576887u) return F_E8; if (n == 57 && c == 0x3cd7e57eu) return F_E8E9; if (n == 120 && c == 0x3769893fu) return F_ITANIUM;
  if (n == 29 && c == 0x0e06077du) return F_DELTA; if (n == 149 && c == 0x1c2c5dc8u) return F_RGB; if (n == 216 && c == 0xbc85e701u) return F_AUDIO;
  return 0;
}
static int add_vm_code(UInt32 first, Byte *code, UInt32 len, size_t op, const char **why) {
  BR v; v.in = code; v.len = len; v.bit = 0; v.overrun = 0; UInt32 fp;
  if (first & 0x80) { fp = vm_readdata(&v); if (fp == 0) { nfdefs = 0; lastFilter = 0; } else fp--; } else fp = lastFilter;
  if ((int)fp > nfdefs || fp >= 1024) { *why = "VM-BAD-FILTER-INDEX"; free(code); return 0; }
  lastFilter = fp; int isNew = ((int)fp == nfdefs); if (isNew) { fdefs[nfdefs].type = 0; fdefs[nfdefs].oldLen = 0; nfdefs++; }
  UInt32 bstart = vm_readdata(&v); if (first & 0x40) bstart += 258;
  UInt32 blen = (first & 0x20) ? vm_readdata(&v) : fdefs[fp].oldLen; fdefs[fp].oldLen = blen;
  FilterRun fr; memset(&fr, 0, sizeof(fr)); fr.start = op + bstart; fr.len = blen; fr.R[3] = 0x3C000; fr.R[4] = blen;
  if (first & 0x10) { UInt32 mask = br_peek16(&v) >> 9; br_skip(&v, 7); for (int i = 0; i < 7; i++) if (mask & (1u << i)) fr.R[i] = vm_readdata(&v); }
  if (isNew) {
    UInt32 sz = vm_readdata(&v); if (sz >= 0x10000 || sz == 0) { *why = "VM-BAD-CODE-SIZE"; free(code); return 0; }
    Byte *vc = malloc(sz); for (UInt32 i = 0; i < sz; i++) { vc[i] = (Byte)(br_peek16(&v) >> 8); br_skip(&v, 8); }
    int t = ident_filter(vc, sz); if (t < 0) { *why = "VM-CODE-CHECKSUM"; free(vc); free(code); return 0; }
    if (t == 0) { fprintf(stderr, "non-standard VM program: len=%u crc=%08x\n", sz, crc32(vc, sz)); *why = "VM-NONSTANDARD-PROGRAM"; free(vc); free(code); return 0; }
    fdefs[fp].type = t; free(vc);
  }
  fr.type = fdefs[fp].type;
  if (getenv("RAR3PPM_DEBUG")) fprintf(stderr, "filter %s start=%zu len=%u R0=%u R1=%u R6=%u\n", ftype_name[fr.type], fr.start, fr.len, fr.R[0], fr.R[1], fr.R[6]);
  if (nfruns < MAXF) fruns[nfruns++] = fr; else { *why = "TOO-MANY-FILTERS"; free(code); return 0; }
  free(code); return 1;
}
static int read_vm_code(BR *b, size_t op, const char **why) {
  UInt32 first = br_peek16(b) >> 8; br_skip(b, 8); UInt32 len = (first & 7) + 1;
  if (len == 7) { len = (br_peek16(b) >> 8) + 7; br_skip(b, 8); } else if (len == 8) { len = br_peek16(b); br_skip(b, 16); }
  Byte *code = malloc(len + 1); for (UInt32 i = 0; i < len; i++) { code[i] = (Byte)(br_peek16(b) >> 8); br_skip(b, 8); }
  return add_vm_code(first, code, len, op, why);
}
static void apply_filter(const FilterRun *f, const Byte *src, Byte *dst) { /* src/dst: pointers to this block in unfiltered/final buffers */
  UInt32 n = f->len, i;
  if (f->type == F_E8 || f->type == F_E8E9) {
    memcpy(dst, src, n); if (n >= 0x3C000 || n < 4) return; Byte cmp2 = f->type == F_E8E9 ? 0xE9 : 0xE8; const UInt32 FS = 0x1000000;
    for (UInt32 cur = 0; cur < n - 4;) { Byte c = dst[cur++]; if (c == 0xE8 || c == cmp2) { UInt32 off = cur + f->R[6]; UInt32 a; memcpy(&a, dst + cur, 4);
      if (a & 0x80000000u) { if (((a + off) & 0x80000000u) == 0) { a += FS; memcpy(dst + cur, &a, 4); } } else { if (((a - FS) & 0x80000000u) != 0) { a -= off; memcpy(dst + cur, &a, 4); } } cur += 4; } }
  } else if (f->type == F_DELTA) {
    UInt32 ch = f->R[0], sp = 0; for (UInt32 c = 0; c < ch; c++) { Byte prev = 0; for (UInt32 d = c; d < n; d += ch) { prev = (Byte)(prev - src[sp++]); dst[d] = prev; } }
  } else if (f->type == F_RGB) {
    UInt32 width = f->R[0] - 3, posR = f->R[1]; const UInt32 chn = 3;
    for (UInt32 c = 0; c < chn; c++) { UInt32 prev = 0; for (i = c; i < n; i += chn) { UInt32 pred;
      if (i >= width) { const Byte *up = dst + i - width; UInt32 ub = up[0], ul = up[-(int)chn]; pred = prev + ub - ul; int pa = abs((int)(pred - prev)), pb = abs((int)(pred - ub)), pc = abs((int)(pred - ul));
        if (pa <= pb && pa <= pc) pred = prev; else if (pb <= pc) pred = ub; else pred = ul; } else pred = prev;
      dst[i] = (Byte)(prev = (Byte)(pred - *(src++))); } }
    for (i = posR; i + 2 < n; i += 3) { Byte g = dst[i + 1]; dst[i] += g; dst[i + 2] += g; }
  } else if (f->type == F_AUDIO) {
    UInt32 ch = f->R[0]; const Byte *sp = src;
    for (UInt32 c = 0; c < ch; c++) { UInt32 prevByte = 0, prevDelta = 0, Dif[7]; memset(Dif, 0, sizeof(Dif)); int D1 = 0, D2 = 0, D3; int K1 = 0, K2 = 0, K3 = 0;
      for (UInt32 k = c, bc = 0; k < n; k += ch, bc++) { D3 = D2; D2 = (int)prevDelta - D1; D1 = (int)prevDelta;
        UInt32 pred = 8 * prevByte + K1 * D1 + K2 * D2 + K3 * D3; pred = (pred >> 3) & 0xFF; UInt32 cur = *(sp++); pred -= cur; dst[k] = (Byte)pred;
        prevDelta = (UInt32)(int)(signed char)(Byte)(pred - prevByte); prevByte = pred & 0xFF; int D = ((signed char)cur) << 3;
        Dif[0] += abs(D); Dif[1] += abs(D - D1); Dif[2] += abs(D + D1); Dif[3] += abs(D - D2); Dif[4] += abs(D + D2); Dif[5] += abs(D - D3); Dif[6] += abs(D + D3);
        if ((bc & 0x1F) == 0) { UInt32 mn = Dif[0], nm = 0; Dif[0] = 0; for (UInt32 j = 1; j < 7; j++) { if (Dif[j] < mn) { mn = Dif[j]; nm = j; } Dif[j] = 0; }
          switch (nm) { case 1: if (K1 >= -16) K1--; break; case 2: if (K1 < 16) K1++; break; case 3: if (K2 >= -16) K2--; break; case 4: if (K2 < 16) K2++; break; case 5: if (K3 >= -16) K3--; break; case 6: if (K3 < 16) K3++; break; } } } }
  } else memcpy(dst, src, n);
}
/* returns: 0 = next block follows (br positioned after end-of-block bits), 1 = end of file, <0 = error */
static int lz_block(LZ *z, BR *b, Byte *out, size_t *op, size_t unp, const char **why) {
  for (;;) {
    if (*op >= unp) return 1;
    int num = huff_dec(&z->LD, b); if (num < 0 || b->overrun) { *why = "LZ-INPUT-OVERRUN"; return -1; }
    if (num < 256) { out[(*op)++] = (Byte)num; continue; }
    if (num >= 271) {
      int ln = num - 271; UInt32 len = LBase[ln] + 3; int bits = LBits[ln];
      if (bits) { len += br_peek16(b) >> (16 - bits); br_skip(b, bits); }
      int dn = huff_dec(&z->DD, b); if (dn < 0) { *why = "LZ-BAD-DIST-CODE"; return -1; }
      UInt32 dist = DBase[dn] + 1; bits = DBits[dn];
      if (bits) {
        if (dn > 9) {
          if (bits > 4) { dist += ((br_peek16(b) >> (16 - (bits - 4 > 16 ? 16 : (bits - 4)))) << 4); br_skip(b, bits - 4); }
          if (z->lowDistRep > 0) { z->lowDistRep--; dist += z->prevLowDist; }
          else { int ld = huff_dec(&z->LDD, b); if (ld < 0) { *why = "LZ-BAD-LOWDIST"; return -1; } if (ld == 16) { z->lowDistRep = 15; dist += z->prevLowDist; } else { dist += ld; z->prevLowDist = ld; } }
        } else { dist += br_peek16(b) >> (16 - bits); br_skip(b, bits); }
      }
      if (dist >= 0x2000) { len++; if (dist >= 0x40000) len++; }
      z->oldDist[3] = z->oldDist[2]; z->oldDist[2] = z->oldDist[1]; z->oldDist[1] = z->oldDist[0]; z->oldDist[0] = dist; z->lastLength = len;
      if (dist > *op) { *why = "LZ-BAD-DISTANCE"; return -1; }
      copy_str(out, op, unp, len, dist); continue;
    }
    if (num == 256) {
      unsigned v = br_peek16(b); int newTable, newFile = 0;
      if (v & 0x8000) { newTable = 1; br_skip(b, 1); } else { newFile = 1; newTable = (v & 0x4000) != 0; br_skip(b, 2); }
      if (newFile) return 1; if (newTable) return 0; return 0;
    }
    if (num == 257) { if (!read_vm_code(b, *op, why)) return -1; continue; }
    if (num == 258) { if (z->lastLength) { if (z->oldDist[0] > *op) { *why = "LZ-BAD-DISTANCE"; return -1; } copy_str(out, op, unp, z->lastLength, z->oldDist[0]); } continue; }
    if (num < 263) {
      int dnum = num - 259; UInt32 dist = z->oldDist[dnum]; for (int i = dnum; i > 0; i--) z->oldDist[i] = z->oldDist[i - 1]; z->oldDist[0] = dist;
      int lnum = huff_dec(&z->RD, b); if (lnum < 0) { *why = "LZ-BAD-LENCODE"; return -1; }
      UInt32 len = LBase[lnum] + 2; int bits = LBits[lnum]; if (bits) { len += br_peek16(b) >> (16 - bits); br_skip(b, bits); }
      z->lastLength = len; if (dist > *op || dist == 0) { *why = "LZ-BAD-DISTANCE"; return -1; } copy_str(out, op, unp, len, dist); continue;
    }
    if (num < 272) {
      UInt32 dist = SDBase[num - 263] + 1; int bits = SDBits[num - 263]; if (bits) { dist += br_peek16(b) >> (16 - bits); br_skip(b, bits); }
      z->oldDist[3] = z->oldDist[2]; z->oldDist[2] = z->oldDist[1]; z->oldDist[1] = z->oldDist[0]; z->oldDist[0] = dist; z->lastLength = 2;
      if (dist > *op) { *why = "LZ-BAD-DISTANCE"; return -1; } copy_str(out, op, unp, 2, dist); continue;
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: rar3ppm packed.bin UNPACKED_SIZE out.bin\n"); return 2; }
  FILE *f = fopen(argv[1], "rb"); if (!f) { perror("open"); return 2; }
  fseek(f, 0, SEEK_END); size_t plen = ftell(f); fseek(f, 0, SEEK_SET); Byte *pin = malloc(plen); if (fread(pin, 1, plen, f) != plen) return 2; fclose(f);
  size_t unp = (size_t)strtoull(argv[2], 0, 10); Byte *out = malloc(unp + 8); size_t op = 0; crc_init(); init_dtables();
  fruns = (FilterRun *)calloc(MAXF, sizeof(FilterRun)); CPpmd7 *p = (CPpmd7 *)calloc(1, sizeof(CPpmd7)); Construct(p); LZ *z = (LZ *)calloc(1, sizeof(LZ));
  RC rc; memset(&rc, 0, sizeof(rc)); rc.in = pin; rc.len = plen; rc.pos = 0;
  int esc = 2, haveModel = 0; const char *status = "OK"; size_t blocks = 0, ppmBlocks = 0, lzBlocks = 0, esc4 = 0, esc5 = 0; int dbg = getenv("RAR3PPM_DEBUG") != 0;
  while (op < unp) {
    size_t bytepos = rc.pos; Byte b0 = bytepos < plen ? pin[bytepos] : 0; blocks++;
    if (b0 & 0x80) {
      ppmBlocks++; rc.pos = bytepos + 1; unsigned maxOrder = b0 & 0x1F; int reset = (b0 & 0x20) != 0; unsigned memMB = 0;
      if (reset) memMB = rc_byte(&rc) + 1; else if (!haveModel) { status = "NO-MODEL"; break; }
      if (b0 & 0x40) esc = rc_byte(&rc);
      rc_init(&rc);
      if (reset) {
        maxOrder += 1; if (maxOrder > 16) maxOrder = 16 + (maxOrder - 16) * 3;
        if (maxOrder == 1) { status = "BAD-ORDER"; break; }
        free(p->Base); Construct(p); if (!Alloc(p, memMB << 20)) { status = "ALLOC-FAIL"; break; }
        Init(p, maxOrder); haveModel = 1;
      }
      int newBlock = 0;
      while (op < unp) {
        int sym = DecodeSymbol(p, &rc);
        if (sym < 0) { status = sym == -1 ? "END-MARK" : "DATA-ERROR"; goto done; }
        if (rc.overrun) { status = "INPUT-OVERRUN"; goto done; }
        if (sym != esc) { out[op++] = (Byte)sym; continue; }
        int nx = DecodeSymbol(p, &rc); if (nx < 0) { status = "DATA-ERROR-IN-ESC"; goto done; }
        if (nx == 0) { newBlock = 1; break; }
        if (nx == 2) { status = "END-OF-FILE-CODE"; goto done; }
        if (nx == 3) {
          int fb = DecodeSymbol(p, &rc); if (fb < 0) { status = "DATA-ERROR-IN-VM"; goto done; }
          UInt32 len = (fb & 7) + 1;
          if (len == 7) { int b1 = DecodeSymbol(p, &rc); if (b1 < 0) { status = "DATA-ERROR-IN-VM"; goto done; } len = b1 + 7; }
          else if (len == 8) { int b1 = DecodeSymbol(p, &rc), b2 = DecodeSymbol(p, &rc); if (b1 < 0 || b2 < 0) { status = "DATA-ERROR-IN-VM"; goto done; } len = b1 * 256 + b2; }
          Byte *code = malloc(len + 1); for (UInt32 i = 0; i < len; i++) { int c = DecodeSymbol(p, &rc); if (c < 0) { status = "DATA-ERROR-IN-VM"; goto done; } code[i] = (Byte)c; }
          const char *why = ""; if (!add_vm_code((UInt32)fb, code, len, op, &why)) { status = why; goto done; }
          continue;
        }
        if (nx == 4 || nx == 5) {
          UInt32 dist = 1, len; int ok = 1;
          if (nx == 4) { UInt32 d = 0; for (int i = 0; i < 3; i++) { int c = DecodeSymbol(p, &rc); if (c < 0) { ok = 0; break; } d = (d << 8) + (Byte)c; } dist = d + 2; len = 32; esc4++; }
          else { len = 4; esc5++; }
          if (ok) { int c = DecodeSymbol(p, &rc); if (c < 0) ok = 0; else len += (Byte)c; }
          if (!ok) { status = "DATA-ERROR-IN-COPY"; goto done; }
          if (dist > op) { status = "BAD-DISTANCE"; goto done; }
          while (len-- && op < unp) { out[op] = out[op - dist]; op++; }
          continue;
        }
        out[op++] = (Byte)esc; continue; /* any other code after the escape byte = the literal escape byte (as libarchive/unrar) */
      }
      if (!newBlock) break;
      if (dbg) fprintf(stderr, "PPM block ended at out=%zu in=%zu\n", op, rc.pos);
    } else {
      lzBlocks++; BR br; br.in = pin; br.len = plen; br.bit = bytepos * 8; br.overrun = 0;
      int keep = (b0 & 0x40) != 0; br_skip(&br, 2);
      if (!lz_read_tables(z, &br, keep)) { status = "LZ-TABLE-ERROR"; goto done; }
      if (dbg) fprintf(stderr, "LZ block: keep=%d tables read at in=%zu out=%zu\n", keep, br.bit / 8, op);
      for (;;) {
        const char *why = "";
        int r = lz_block(z, &br, out, &op, unp, &why);
        if (r < 0) { status = why; goto done; }
        if (r == 1) goto finished;
        /* new table follows: align to the next byte, then re-read a block header (may be LZ tables or a PPM switch) */
        br.bit = (br.bit + 7) & ~(size_t)7;
        { unsigned v = br_peek16(&br); if (v & 0x8000) { rc.pos = br.bit / 8; goto next_block; } int keep2 = (v & 0x4000) != 0; br_skip(&br, 2); if (!lz_read_tables(z, &br, keep2)) { status = "LZ-TABLE-ERROR"; goto done; } lzBlocks++; if (dbg) fprintf(stderr, "LZ new tables keep=%d at in=%zu out=%zu\n", keep2, br.bit / 8, op); }
      }
    }
    next_block:;
  }
finished:;
done:;
  Byte *fin = out; size_t applied = 0;
  if (nfruns) { fin = malloc(op + 8); memcpy(fin, out, op);
    for (size_t k = 0; k < nfruns; k++) { FilterRun *f = &fruns[k]; if (f->start + f->len > op) continue; apply_filter(f, out + f->start, fin + f->start); applied++; } }
  FILE *o = fopen(argv[3], "wb"); fwrite(fin, 1, op, o); fclose(o); out = fin;
  if (nfruns) fprintf(stderr, "filters recorded=%zu applied=%zu\n", nfruns, applied);
  printf("crc32=%08x produced=%zu expected=%zu blocks=%zu ppm=%zu lz=%zu esc4=%zu esc5=%zu status=%s\n", crc32(out, op), op, unp, blocks, ppmBlocks, lzBlocks, esc4, esc5, status);
  return 0;
}
