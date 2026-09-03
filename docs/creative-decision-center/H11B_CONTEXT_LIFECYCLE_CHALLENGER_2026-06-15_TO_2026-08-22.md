# H11B context lifecycle challenger — current (v2) vs challenger (v3)

- bundleHash: 58de78a12a15681ee51de1049f6463971d12231090dad33cd5c72586c5651b91
- candidates: v2=campaign-context-resolver.v2-account-scoped-2026-08-29 v3=campaign-context-resolver.v3-lifecycle-2026-08-29
- truth window: ±45d of label stamp

## Fold: train
- current_v2: labeled=45 classified=28 coverage=0.6222 exactAcc=0.5357 [wilson 0.358-0.705] high n=5 highAcc=0.8000 [wilson 0.376-0.964] falseTestAny=2 falseTestHigh=0 manualTest=3 testRecall=0.0000 unresolved=43 conflict=1
  confusion(manual->predicted): {"main":{"main":15,"test":1,"mixed":0,"unresolved":14,"conflict":0},"test":{"main":0,"test":0,"mixed":0,"unresolved":2,"conflict":1},"mixed":{"main":11,"test":1,"mixed":0,"unresolved":0,"conflict":0}}
  calibration by class: {"medium":{"n":7,"correct":5},"low":{"n":16,"correct":6},"high":{"n":5,"correct":4}}
    Bilsem Zeka/act_840779107261785: labeled=7 classified=7 coverage=1.0000 exactAcc=0.4286 [wilson 0.158-0.750] high n=0 highAcc=n/a [wilson n/a] falseTestAny=1 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=4 conflict=0
    ColorFullWorldsTR/act_3554615364751964: labeled=2 classified=1 coverage=0.5000 exactAcc=1.0000 [wilson 0.207-1.000] high n=1 highAcc=1.0000 [wilson 0.207-1.000] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=2 conflict=0
    Grandmix/act_805150454596350: labeled=8 classified=7 coverage=0.8750 exactAcc=0.8571 [wilson 0.487-0.974] high n=2 highAcc=1.0000 [wilson 0.342-1.000] falseTestAny=1 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=5 conflict=0
    IwaStore/act_1087566732415606: labeled=8 classified=5 coverage=0.6250 exactAcc=1.0000 [wilson 0.566-1.000] high n=1 highAcc=1.0000 [wilson 0.207-1.000] falseTestAny=0 falseTestHigh=0 manualTest=1 testRecall=0.0000 unresolved=4 conflict=1
    TheSwaf/act_822913786458311: labeled=18 classified=6 coverage=0.3333 exactAcc=0.0000 [wilson 0.000-0.390] high n=0 highAcc=n/a [wilson n/a] falseTestAny=0 falseTestHigh=0 manualTest=2 testRecall=0.0000 unresolved=28 conflict=0
    TheSwaf/act_921275999286619: labeled=2 classified=2 coverage=1.0000 exactAcc=0.0000 [wilson 0.000-0.658] high n=1 highAcc=0.0000 [wilson 0.000-0.793] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=0 conflict=0
- challenger_v3: labeled=45 classified=26 coverage=0.5778 exactAcc=0.5385 [wilson 0.355-0.712] high n=7 highAcc=0.8571 [wilson 0.487-0.974] falseTestAny=7 falseTestHigh=0 manualTest=3 testRecall=0.0000 unresolved=43 conflict=3
  confusion(manual->predicted): {"main":{"main":13,"test":3,"mixed":0,"unresolved":14,"conflict":0},"test":{"main":0,"test":0,"mixed":0,"unresolved":2,"conflict":1},"mixed":{"main":5,"test":4,"mixed":1,"unresolved":0,"conflict":2}}
  calibration by class: {"high":{"n":7,"correct":6},"medium":{"n":7,"correct":4},"low":{"n":12,"correct":4}}
    Bilsem Zeka/act_840779107261785: labeled=7 classified=7 coverage=1.0000 exactAcc=0.5714 [wilson 0.250-0.842] high n=2 highAcc=1.0000 [wilson 0.342-1.000] falseTestAny=2 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=4 conflict=0
    ColorFullWorldsTR/act_3554615364751964: labeled=2 classified=1 coverage=0.5000 exactAcc=1.0000 [wilson 0.207-1.000] high n=1 highAcc=1.0000 [wilson 0.207-1.000] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=2 conflict=0
    Grandmix/act_805150454596350: labeled=8 classified=7 coverage=0.8750 exactAcc=0.8571 [wilson 0.487-0.974] high n=2 highAcc=1.0000 [wilson 0.342-1.000] falseTestAny=1 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=5 conflict=0
    IwaStore/act_1087566732415606: labeled=8 classified=5 coverage=0.6250 exactAcc=0.6000 [wilson 0.231-0.882] high n=1 highAcc=1.0000 [wilson 0.207-1.000] falseTestAny=2 falseTestHigh=0 manualTest=1 testRecall=0.0000 unresolved=4 conflict=1
    TheSwaf/act_822913786458311: labeled=18 classified=4 coverage=0.2222 exactAcc=0.0000 [wilson 0.000-0.490] high n=0 highAcc=n/a [wilson n/a] falseTestAny=2 falseTestHigh=0 manualTest=2 testRecall=0.0000 unresolved=28 conflict=2
    TheSwaf/act_921275999286619: labeled=2 classified=2 coverage=1.0000 exactAcc=0.0000 [wilson 0.000-0.658] high n=1 highAcc=0.0000 [wilson 0.000-0.793] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=0 conflict=0
  labeled disagreements v2->v3: 12
    Bilsem Zeka 120248074741060626 label=main: v2=main/medium -> v3=main/high
    Bilsem Zeka 120248078612090626 label=mixed: v2=main/low -> v3=mixed/high
    Bilsem Zeka 120248078458340626 label=main: v2=main/low -> v3=main/medium
    Bilsem Zeka 120232436484040626 label=mixed: v2=main/low -> v3=test/low
    Grandmix 120247884799930316 label=main: v2=main/medium -> v3=main/low
    TheSwaf 120248656676830042 label=mixed: v2=main/low -> v3=null/conflict
    TheSwaf 120248656753610042 label=mixed: v2=main/low -> v3=null/conflict
    TheSwaf 120248657047720042 label=mixed: v2=main/low -> v3=test/low
    TheSwaf 120248657114880042 label=mixed: v2=main/low -> v3=test/low
    Grandmix 120251401021240316 label=main: v2=test/low -> v3=test/medium
    IwaStore 120246476058270077 label=main: v2=main/low -> v3=test/low
    IwaStore 120246469990750077 label=main: v2=main/low -> v3=test/low

## Fold: validation
- current_v2: labeled=21 classified=20 coverage=0.9524 exactAcc=0.6000 [wilson 0.387-0.781] high n=5 highAcc=0.2000 [wilson 0.036-0.624] falseTestAny=0 falseTestHigh=0 manualTest=2 testRecall=0.5000 unresolved=26 conflict=0
  confusion(manual->predicted): {"main":{"main":11,"test":0,"mixed":1,"unresolved":1,"conflict":0},"test":{"main":0,"test":1,"mixed":1,"unresolved":0,"conflict":0},"mixed":{"main":6,"test":0,"mixed":0,"unresolved":0,"conflict":0}}
  calibration by class: {"low":{"n":11,"correct":9},"medium":{"n":4,"correct":2},"high":{"n":5,"correct":1}}
    Bilsem Zeka/act_840779107261785: labeled=7 classified=7 coverage=1.0000 exactAcc=0.4286 [wilson 0.158-0.750] high n=0 highAcc=n/a [wilson n/a] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=2 conflict=0
    Grandmix/act_805150454596350: labeled=3 classified=2 coverage=0.6667 exactAcc=1.0000 [wilson 0.342-1.000] high n=1 highAcc=1.0000 [wilson 0.207-1.000] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=3 conflict=0
    IwaStore/act_1087566732415606: labeled=5 classified=5 coverage=1.0000 exactAcc=0.6000 [wilson 0.231-0.882] high n=2 highAcc=0.0000 [wilson 0.000-0.658] falseTestAny=0 falseTestHigh=0 manualTest=1 testRecall=0.0000 unresolved=8 conflict=0
    TheSwaf/act_822913786458311: labeled=4 classified=4 coverage=1.0000 exactAcc=1.0000 [wilson 0.510-1.000] high n=0 highAcc=n/a [wilson n/a] falseTestAny=0 falseTestHigh=0 manualTest=1 testRecall=1.0000 unresolved=10 conflict=0
    TheSwaf/act_921275999286619: labeled=2 classified=2 coverage=1.0000 exactAcc=0.0000 [wilson 0.000-0.658] high n=2 highAcc=0.0000 [wilson 0.000-0.658] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=0 conflict=0
- challenger_v3: labeled=21 classified=20 coverage=0.9524 exactAcc=0.5500 [wilson 0.342-0.742] high n=4 highAcc=0.5000 [wilson 0.150-0.850] falseTestAny=1 falseTestHigh=0 manualTest=2 testRecall=0.0000 unresolved=26 conflict=0
  confusion(manual->predicted): {"main":{"main":11,"test":1,"mixed":0,"unresolved":1,"conflict":0},"test":{"main":2,"test":0,"mixed":0,"unresolved":0,"conflict":0},"mixed":{"main":6,"test":0,"mixed":0,"unresolved":0,"conflict":0}}
  calibration by class: {"medium":{"n":6,"correct":4},"low":{"n":10,"correct":5},"high":{"n":4,"correct":2}}
    Bilsem Zeka/act_840779107261785: labeled=7 classified=7 coverage=1.0000 exactAcc=0.4286 [wilson 0.158-0.750] high n=0 highAcc=n/a [wilson n/a] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=2 conflict=0
    Grandmix/act_805150454596350: labeled=3 classified=2 coverage=0.6667 exactAcc=1.0000 [wilson 0.342-1.000] high n=1 highAcc=1.0000 [wilson 0.207-1.000] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=3 conflict=0
    IwaStore/act_1087566732415606: labeled=5 classified=5 coverage=1.0000 exactAcc=0.8000 [wilson 0.376-0.964] high n=1 highAcc=1.0000 [wilson 0.207-1.000] falseTestAny=0 falseTestHigh=0 manualTest=1 testRecall=0.0000 unresolved=8 conflict=0
    TheSwaf/act_822913786458311: labeled=4 classified=4 coverage=1.0000 exactAcc=0.5000 [wilson 0.150-0.850] high n=0 highAcc=n/a [wilson n/a] falseTestAny=1 falseTestHigh=0 manualTest=1 testRecall=0.0000 unresolved=10 conflict=0
    TheSwaf/act_921275999286619: labeled=2 classified=2 coverage=1.0000 exactAcc=0.0000 [wilson 0.000-0.658] high n=2 highAcc=0.0000 [wilson 0.000-0.658] falseTestAny=0 falseTestHigh=0 manualTest=0 testRecall=n/a unresolved=0 conflict=0
  labeled disagreements v2->v3: 8
    Bilsem Zeka 120248074741060626 label=main: v2=main/low -> v3=main/medium
    Bilsem Zeka 120248078458340626 label=main: v2=main/low -> v3=main/medium
    Grandmix 120251840488910316 label=main: v2=main/low -> v3=main/medium
    IwaStore 120247180918480077 label=main: v2=mixed/high -> v3=main/high
    IwaStore 120247180918580077 label=test: v2=mixed/high -> v3=main/low
    TheSwaf 120251375468670042 label=test: v2=test/low -> v3=main/low
    TheSwaf 120251381036160042 label=main: v2=main/medium -> v3=main/low
    TheSwaf 120251387399090042 label=main: v2=main/low -> v3=test/low

## D076 predeclared gate (validation fold)
- [FAIL] G1_high_confidence_accuracy: v3 high n=4 acc=0.5000 vs v2 acc=0.2000 (need n>=5, acc>=0.8, >=v2)
- [PASS] G2_false_test_high: v3 falseTestHigh=0
- [FAIL] G3_false_test_any_non_inferior: v3 falseTestAny=1 vs v2=0
- [PASS] G4_coverage: v3 coverage=0.9524 vs v2=0.9524 (allow -0.05)
- [PASS] G5_high_mixed_on_main: v3 high-confidence mixed on main-labeled=0
- [FAIL] G6_lobo_stability: flipped by excluding: Bilsem Zeka, ColorFullWorldsTR, Grandmix, IwaStore, IwaTR
- [PASS] G7_unlabeled_high_test_share: all accounts <=5% high-confidence Test share on unlabeled inventory

## VERDICT: REJECT

### LOBO (validation, v3, excluding one business at a time)
- without Bilsem Zeka: labeled=14 classified=13 coverage=0.9286 exactAcc=0.6154 [wilson 0.355-0.823] high n=4 highAcc=0.5000 [wilson 0.150-0.850] falseTestAny=1 falseTestHigh=0 manualTest=2 testRecall=0.0000 unresolved=24 conflict=0
- without ColorFullWorldsTR: labeled=21 classified=20 coverage=0.9524 exactAcc=0.5500 [wilson 0.342-0.742] high n=4 highAcc=0.5000 [wilson 0.150-0.850] falseTestAny=1 falseTestHigh=0 manualTest=2 testRecall=0.0000 unresolved=26 conflict=0
- without Grandmix: labeled=18 classified=18 coverage=1.0000 exactAcc=0.5000 [wilson 0.290-0.710] high n=3 highAcc=0.3333 [wilson 0.061-0.792] falseTestAny=1 falseTestHigh=0 manualTest=2 testRecall=0.0000 unresolved=23 conflict=0
- without IwaStore: labeled=16 classified=15 coverage=0.9375 exactAcc=0.4667 [wilson 0.248-0.699] high n=3 highAcc=0.3333 [wilson 0.061-0.792] falseTestAny=1 falseTestHigh=0 manualTest=1 testRecall=0.0000 unresolved=18 conflict=0
- without IwaTR: labeled=21 classified=20 coverage=0.9524 exactAcc=0.5500 [wilson 0.342-0.742] high n=4 highAcc=0.5000 [wilson 0.150-0.850] falseTestAny=1 falseTestHigh=0 manualTest=2 testRecall=0.0000 unresolved=23 conflict=0
- without TheSwaf: labeled=15 classified=14 coverage=0.9333 exactAcc=0.6429 [wilson 0.388-0.837] high n=2 highAcc=1.0000 [wilson 0.342-1.000] falseTestAny=0 falseTestHigh=0 manualTest=1 testRecall=0.0000 unresolved=16 conflict=0
