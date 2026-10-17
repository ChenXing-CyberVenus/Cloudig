import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repository = process.cwd();
const designRoot = path.resolve(repository, "..", "阅读器美术素材", "Cloudig-Image");
const iconRoot = path.resolve(repository, "..", "阅读器美术素材", "AI-Icon");
const acceptedDerivativeRoot = path.join(repository, "reader", "assets", "cover");
const acceptedArchiverDerivativeRoot = path.join(repository, "ui", "assets", "archiver");
const assetRoot = path.join(repository, "src", "ui", "assets");
const outputRoot = path.join(assetRoot, "welcome");

const assets = [
  ["Back-Light-start-1920.png", "1075fbb19fc93c9ce2adb92d37cd936e512ef082a3c20efd78d527a6b76b377e", "copy"],
  ["Back-Light-1920.png", "5c102e729fc995907d5b4beed84f71540b1381c1859368ac33f9591711d8234c", "copy"],
  ["Back-Abyss-1920.png", "3fb127678479259d5a20862fb5413abed4a0dc2522026cf1270366312506c3d3", "copy"],
  ["Back-Horizon-1920.png", "006a677edb766d659c064d262d0fb92412a7b81d55bf554f1b9afcd97bba6f01", "copy"],
  ["OsisLogo-Main-1024.png", "d5952d30156c5f5c3ba30905cfbe1f3594097f1dae3fc0eb7c7b6169c8969ae6", "copy"],
  ["OsisLogo-Cloudig-1024.png", "97293bfea08bda347bb4d2d765dea6380855add62548bae9d99c0f5c08bd0d35", "copy"],
  ["Cloudig-Logo-Title-Slogan.svg", "71b8650d369e6c1bcee5387000cc432b8cc31de7a77fc5f1a5396e6ec5a9fb4a", "clean-svg"],
  ["OsisLogo-Simple.svg", "0ca6d20e0bd4d7bc0c86098f70b659c74df25207ecf4619ae51f5aa1f95f95c1", "clean-svg"],
  ["OsisLogo-Simple-Mono-Purple.svg", "49f94f8dbcffa14873a59f058b1b7c9a22271f8df8c5bfb8f89c8fdf3aad4676", "clean-svg"],
  ["OsisLogo-Simple-Mono-Orange.svg", "4ead61bb44caf09ccd95441607f19b0fe41219038501142aa366e24dacb7d853", "clean-svg"],
  ["Cover-PhotoFrame-Dawn.svg", "1f9025c9c508cea43b7f2bd430bab6889b6a9c80e2b363d2b0a479c41e192bb1", "clean-svg"],
  ["Cover-PhotoFrame-StarNight.svg", "6a670a8b1916c005b7fef60bb07ea298192a29cc0e7d7d5bc68d0c8f2912e55c", "clean-svg"]
];

const readerAssets = [
  ["OsisLogo-Cloudig-RedBackWhiteAbyss.svg", "b1ba5c286fe5f4306a56d5153f22197589171250ae015ffd0101882d2e579aea", "clean-svg"],
  ["OsisLogo-Cloudig-PurpleBackOrangeAbyss.svg", "4e05b9cfaf823311ca2ffde65589bab1da98f6d86cd912e8c34f9f55609184ef", "clean-svg"],
  ["Cloudig-Title-Chinese-Grey-Dark-1024.png", "61e8d0fb5b577db2407b6c46f08abe452244c998e2925fc6c4268d837b651ad3", "copy"],
  ["Cloudig-Title-Chinese-Grey-Light-1024.png", "8065e90cb2a24d893ec5c587df993b265b91c57adcf4a042af03f003d6683a89", "copy"],
  ["Cloudig-Slogan-Chinese-Grey-Dark-1024.png", "8576a1c1178a281b474d6afcb8b3b7606d0fb0c2923910ce9e50abf36ed4c3ef", "copy"],
  ["Cloudig-Slogan-Chinese-Grey-Light-1024.png", "0dd5f153a7b963089203988835b2f20259401dad10c9f3692f4ca1394e8d10a7", "copy"],
  ["Cloudig-Slogan-English-Grey-Dark-1024.png", "7768fcb58a897543c934fddccb97dd2688262a6a5b0f32c41dbdc9f356b81751", "copy"],
  ["Cloudig-Slogan-English-Grey-Light-1024.png", "5763eb2b995c9aa8986fd7964b99467562a9d4452178cda9c7cfe7afd72483c7", "copy"],
  ["Cloudig-Title-English-Grey-Dark.svg", "44a381d49268408e655288fd1ac62cc628b979e3ab64d0d211c69d078eaeeaed", "copy"],
  ["Cloudig-Title-English-Grey-Light.svg", "29145f03b995d18b45ea9bf4424aa932d63e962405223c1317ab7a8b459dc3e7", "copy"],
  ["Cloudig-Slogan-English-Grey-Dark.svg", "d2e265f7eee02fbb9d8bbf0298e05f6ce787c7448d0d7590f71bc4287245cc0e", "copy"],
  ["Cloudig-Slogan-English-Grey-Light.svg", "ae0c6c25bbd38eea61613a1041679d328951bae1b5a251f9378ecbf12d49286d", "copy"],
  ["Waiting-Sun.gif", "2904f9f8174bb6f4a730b1ec6858ce3989432fb3021ccb89e6367f1e522138b3", "copy"],
  ["OsisLogo-Simple-Mono-Red.svg", "a6a221957fc1803ff1fc9d802277a9b6d4e699553101e4d34639c3bd763c51b8", "clean-svg"],
  ["Conversation-Title-Back-Dawn.svg", "36eaea3ea57f8b6e9ea763197cb1df31662bff6c00dd3459d06e3855ef541340", "stretch-title-background"],
  ["Conversation-Title-Back-StarNight.svg", "138f1174e405545ab4ee05824ebf04f19fca94706c9ad254a2121dc26f7ee1de", "stretch-title-background"],
  ["ToolBar-Pattern-Dawn.svg", "e135fb4f2db4c83cc6d17c50c7291114c3b1138f6db7e756094af915268dfd34", "clean-svg"],
  ["ToolBar-Pattern-StarNight.svg", "87ff4e1651a5dac8ff66b06fc44622e15a0ae7023a80c7d59aa05c85e0b2b8b4", "clean-svg"],
  ["Button-Name-Flower.svg", "257ad0e06d1d4352ac9c836d6b5b79f00d00b55f8ea3d12bbbd162551e9aeb1a", "clean-svg"],
  ["Button-Time-Clock.svg", "d78ea03ec2103ae3815df7164af0332fea7aa71dd07cf56fa62ebe1177666106", "clean-svg"],
  ["Button-Time-LightCone.svg", "c852ef4504fa0c20e5e6bb6592ee0d112c25ea011850725ea1a2129a276f7fef", "clean-svg"],
  ["Button-Time-Tea.svg", "d69bebaad945b4bdfaa8a8fa69aeba1641f40e8b5811e3e31112a20a708e5f02", "clean-svg"],
  ["Pushpin-Red.svg", "255209f3e0c07d37fcf3e23005ebe4ad1a0f3c317468ca1440a9708eb1d45a9c", "clean-svg"],
  ["Pushpin-Purple.svg", "bb1a2a0f11e2e2f0e0b683cbd4653942380e8f1fe32dae2860dcacd7c2e604b4", "clean-svg"],
  ["Title-Paper-Selected-Dawn.svg", "aa148ed1ca965cd19cbd557677761c4561fc96f01c72baeb06263139eb781280", "clean-svg"],
  ["Title-Paper-Selected-StarNight.svg", "ea96bebbeeff32a9134103fb4b890700ba54279f4f76e5dc6beb1d0dbd2736d6", "clean-svg"],
  ["Title-Paper-UnSelected-Dawn-01.svg", "7fed308b27a27c2f2413f4f1dc7601bbb02b29d946896f1467b9ced57122c52f", "clean-svg"],
  ["Title-Paper-UnSelected-Dawn-02.svg", "3aba933a678a73116ef5c4bb94abb85feabe91123f8cba6472e355368034e899", "clean-svg"],
  ["Title-Paper-UnSelected-StarNight-01.svg", "261c5238f8b7d358186a1f14eb0f9d38f9fc3afa6510a83db7030d4c6aa63465", "clean-svg"],
  ["Title-Paper-UnSelected-StarNight-02.svg", "6c7cb76fa6a5d09c0bf85518a9e3c935cf8093803c99fb5cd939703d5c7a3388", "clean-svg"],
  ["SmallButterfly-Dawn.svg", "2b200ac4d647d54c794d4b421c4f80041bf6ac0553e5ded85bb1800994ae24ed", "clean-svg"],
  ["SmallButterfly-StarNight.svg", "2663c8084c50a0f3e375bb9030f954f72369b8a50bc009f3f8b895bda00226a1", "clean-svg"],
  ["DecBook-Dawn.svg", "4f777e381ab00825da1571b8dfa042a0e075d94f5289e859725d9d4214c06725", "clean-svg"],
  ["DecBook-StarNight.svg", "b8cd43bb951882f03e81603b7fe9dee5f1a890b83bd4bd182a835a48fdf02180", "clean-svg"],
  ["Windbell-Dawn.svg", "d4ab3de3c8821ced0177026cf8ecac730ec815dec0161464835a3ecbff9cc654", "clean-svg"],
  ["Windbell-StarNight.svg", "b860199b05e390e54ecc68d948309d5c300470795656fdec67900fc8a089b29e", "clean-svg"],
  ["DocBack-Clip.svg", "688c9ebed8b541441fbc33e5269c1f66fe89e64f4f136bd50129799d696c0201", "clean-svg"],
  ["DocBack-Dawn-Backboard.svg", "d3ea6dcf3296d3bea9b8f89543a210282641370107661492d46a9efa36e6d1d3", "clean-svg"],
  ["DocBack-Dawn-Cloud01.svg", "1c9c3f95dcabb2f704d50255ba8039d1f0a66449e13eb0dfb2c0ad2b29014733", "clean-svg"],
  ["DocBack-Dawn-Cloud02.svg", "cd4c1c48a138b9c376c85722f859d6bc65e10e73c34eba0acff3e9b37b084a5b", "clean-svg"],
  ["DocBack-Dawn-Paper-Content.svg", "219eb687f89dec62e530810a0168946a24a0fe474e869564541b91136b5658fa", "clean-svg"],
  ["DocBack-Dawn-Paper-Title.svg", "ca36124151deb99bf0238a0ad6a80779c0546bf11bfb820ddde7a0e5ee20f6a2", "clean-svg"],
  ["DocBack-StarNight-Backboard.svg", "f3f9cdfbc3aa1c573226ace8ec7daeab28c2f932f709ddeb88545dfe48d60da3", "clean-svg"],
  ["DocBack-StarNight-Cloud01.svg", "230f70b82920502e4f1c88ba6ec51d9d1f733bfdb7ae7e13bc275eedac98d967", "clean-svg"],
  ["DocBack-StarNight-Cloud02.svg", "11cd0f8bfc6a95eaaf66f9c04a59c032f8ff57223fa7cc854d89e3d3c982f376", "clean-svg"],
  ["DocBack-StarNight-Paper-Content.svg", "72c65eadcaeed6f427bab2c874e9270967a157a8a0eeb84e60dac970d9dd3e4c", "clean-svg"],
  ["DocBack-StarNight-Paper-Title.svg", "6e2ee6901d56f4e543ddc61d5d69ef899642750dddecf4e325fee7688beb0622", "clean-svg"],
  ["DocBack-Dawn.svg", "e01f92e3eae03ee5194e00577816f905c503324182feaadc66a7eebaeeb5540b", "copy"],
  ["DocBack-StarNight.svg", "c7d9cff341f3a0a303a77a7b4e99b0be7e60600d947bfcf801ca177bd10ce963", "copy"],
  ["ChenXing-Avatar.png", "f3ca9af4288f3adbc900c136ca40acedaa13fed43b5d1c95712c059cfabbdd5f", "copy"],
  ["RCSD-百叶窗.svg", "c59d2204aa34e24906ae36bed012137e4a0ee4492b7f60c2a5c15e8746874e87", "clean-svg"],
  ["RCSD-破晓窗户.svg", "a50ce6020172a53bf5a8100640c8223caa6ada529f19c3d3b67082dc426d758f", "clean-svg"],
  ["RCSD-窗台.svg", "e6cab7aa9d73e564b01ffe70b0aab4c6e161ee1fb4d896d6320d8376943f3499", "clean-svg"],
  ["RCSD-墙面装饰.svg", "18d5d1c76dd533e8b25c1c64739fafacdfdaa7bf320874cdb3592f6bbcf12393", "clean-svg"],
  ["RCSD-墙面架子.svg", "d8c180c72ae3292a5e8214034acb36125fdb494c7acf2bc44b1a0fa5a1d04915", "clean-svg"],
  ["RCSD-思考者小雕塑.svg", "c2f90b43c4049e09ebfd20386b1c5a0535dd6f3bb0f38e3c3421571d1e440c27", "clean-svg"],
  ["RCSD-桌面与杂物.svg", "4357cc83fe1b5b9daf0dfe3cba17a328fad94274e9f4556fe28a5fe0e75e75dd", "clean-svg"],
  ["RCSD-花.svg", "359554935a40b9424801b859863638b99c021c63462d18f6bb17074324c827f6", "clean-svg"],
  ["RCSD-肥肥相片.svg", "0b644fdfb2baecf87a6c716aafbe807a7726ca98da60475d5a21f1cff3b10eb2", "clean-svg"],
  ["RCSD-肥肥相框.svg", "0efc26ccaf07513ebf4bb88f4038e235de81d1306e6e252c9a92b0c4c227b331", "clean-svg"],
  ["Reader-Cover-Computer-Dawn.svg", "2a7003e84115b26137fba62d541f21ef27470494547898a2bb9b1112ad3df1a1", "clean-svg"],
  ["RCSS-星夜窗户.svg", "065bba35396f685bbd44c402231eed0c9f41e4c7893ca149e001cbd73266091d", "clean-svg"],
  ["RCSS-星夜.svg", "fe6325536f50cc1f930ca77c174d793d7af620491fe9992ae75ef5a5fce8e76e", "clean-svg"],
  ["RCSS-时光建筑群.svg", "fce1193cb56cd9b6b928cd3c8d35716fec77e779aa7da0b5255f357b6738c7d0", "clean-svg"],
  ["RCSS-窗台植物.svg", "7d462c0704ef07be2c172a7c96a7d1563158863cddf08ed09aa551a61a1e4b3b", "clean-svg"],
  ["RCSS-桌面与电脑-黑灯.svg", "134fcf532a8ca9baf7e84751bc8260f12f62e6d0d274647d0be5b5e7e6a3e1cb", "clean-svg"],
  ["RCSS-光锥.svg", "0000fc564ffe1175e2a3c6cf53ab7ccd3652e664c2aaf4266c14820b988d0eee", "clean-svg"],
  ["RCSS-光锥蒙版下的桌面与电脑.svg", "cbf07b7e2ae26aa55815779dc0795e7e913d2eb08f42fe9902eaa9feef22a5af", "copy"],
  ["RCSS-部分光锥影响下的屏幕.svg", "106af2e305f784be1ce33d61e5fc876704f3cdc1e6b4ac9ee68e2a735f5b3ab3", "copy"],
  ["RCSS-窗帘.svg", "63576d5aedccba29aa85b84af9f483e860e88da25b6193eef4e431b06aae880b", "clean-svg"],
  ["RCSS-黑灯窗台.svg", "bcca675e1b2ead177e4129443e8e0497b1c9720a6623811aa406108523c1ace2", "clean-svg"],
  ["RCSS-亮灯窗台.svg", "9e57e7354f4d16b2d4e37bf35b159469449685d77be0614339061d3db2d0d73e", "clean-svg"],
  ["RCSS-光锥影响下的部分亮光窗台.svg", "27d83b4dc745110ff798e2711a85d30f225bdb82df15068c5f6e6989e578e31b", "clean-svg"]
];

const archiverAssets = [
  ["Phoenix.svg", "f5005e4a3d44403391bda4e7945995ade3e39956a9a9078892135534eb98ca29", "clean-svg"],
  ["Rocket.svg", "0f1b93db51af8cc515c3717cdb69db10c907dc80e4434bedf9919fede15128f0", "clean-svg"],
  ["Ship.svg", "286f4cfadfbcbbd56a2e85b4086d65759c1a408517d33cee51c14bbaede2361f", "clean-svg"],
  ["SailboatWithShadow.svg", "bce0cafbcc5a715a650fb01bccc8fce5918554b1b6cbbe33fdda5a125e2a3829", "clean-svg"],
  ["RockStage.svg", "a597c447133a6f46ac2a7fdf4d4bc7c1225e9abb51239a3be82bad819ec797ae", "clean-svg"],
  ["Astronaut.svg", "e8c0d25582792889cb23b4e88644d7466ef409dded6af483f7b6112cca7a629f", "clean-svg"],
  ["Sunflower.svg", "7a6534e50255e42536bd4985b1d8253dcb68e1caaaddd786c67d14bad3f769ff", "clean-svg"],
  ["PinkGreenTrees.svg", "f798d1466b0f66f3f261199df128584b7cfdfdca7c845a6e60787f56a423cad7", "clean-svg"],
  ["GirlInForest.svg", "fca154c6579d0ff3201ffcab0e909a2a4f96b7502d63f46f7a8f1f0bd7c3a732", "clean-svg"],
  ["WildTree.svg", "83b97d8bae321ee4c69247890890ca3bf899402a3407408a733cdb0d83bf6849", "clean-svg"],
  ["Wave-Blue.svg", "8bd6c84ec578e0894da3ba9f490d75b07761d72031153fb5027e01058bf85bec", "clean-svg"],
  ["Wave-Green.svg", "7abb46405691d04110347db194d8cd8a469c1bcd992bc901e982afc0e78a3c40", "clean-svg"],
  ["Village-Dusk.svg", "577629b2bbfc2646237525e86de7e6de72b8922bc6f8aec77ae65b577412249b", "clean-svg"],
  ["Village-Night.svg", "8b1d28d02f5f5d42153bb23c2d6a31f0a1d89df90211be77db3bbbcb9f3178af", "clean-svg"],
  ["TitleDec-Explosion.svg", "abd0d61bc480fbc0d1cdafb2cf05853dc3fb07eacef8a0719560e97354da0914", "clean-svg"],
  ["TitleDec-Garden.svg", "7af3253b60299932b0bba49d39ac6ce2204271b94d15e9a1606a74d5d9f1baad", "clean-svg"],
  ["TitleDec-Homeland.svg", "75aff37eea6af3af701c9a5f1c4850277d308153f7ad2ac2e33cba5b89a2a65e", "clean-svg"],
  ["TitleDec-Pompeii.svg", "5016f805741d716a7924df2409493ed48470bb390bff15e646b156ac766e5d90", "clean-svg"],
  ["TitleDec-Conquer.svg", "0fdd41e9ed30787311e4164a9c213458aa6ad608af71a6b323fb74df255485de", "clean-svg"],
  ["TitleDec-Planet.svg", "106b90d37378089fd0257a7e15b419a0882a7a357be9c8d449569934a09c6a95", "clean-svg"]
];

const acceptedArchiverDerivatives = [
  [
    "Cock.svg",
    "350a329142a4673b5381a0113a0ebcdb3c48566d0e3789eff2c02b5946d1af9c",
    "ad375c409b6dfee7216c77283bef52c3a13aaf2b8c6d8b32df57bd7db522f118"
  ]
];

const editorAssets = [
  ["EditorBack-Tao.svg", "221e44b083f6bdc121911a7e60ed6ff967ecefa47489803c30285d046e4d9ef6", "copy"],
  ["EditorBack-Drawer.svg", "96ce75bfee45fe360334783c7d4085eaedb321e9813b6c93dea3235acc049057", "copy"],
  ["ContentTimeTitleBack-Dawn.svg", "b80cc87f51786dd294a5a86e34e6cb9c987f2e6f86b4159072d3b2ae38da2601", "copy"],
  ["ContentTimeTitleBack-StarNight.svg", "cf1a3b2bb12de5c041db4acef6cbe1f5c431ae461381746738d9e014bf0ee877", "copy"],
  ["TimeCloud-Blue.svg", "efa7a1f88deea9cc26c07ed5e2c54b2ace9fe2f39e575ba91d8d6bdb4ced506d", "copy"],
  ["TimeCloud-DarkGrey.svg", "feed20d949b9cf45775cb9e01e2bb6f990029f53c00dedf8f2c64cd06f346c6d", "copy"],
  ["TimeCloud-LightGrey.svg", "2a7146d0be09f5f44a3dd31db934e149d2c0386c2157a4d2c5dd367c6384322b", "copy"],
  ["TimeCloud-Red.svg", "283bcb4f2887a2e3151e6fdf4da15b376cc141f1af6cbae5ad618d84b066dac3", "copy"],
  ["TimeLOGO-Sovereign.svg", "a1b46920b3b2bb87d1c48fdff325426e936e683f32a1dfce699cceea10439019", "copy"],
  ["TimeLOGO-Terran.svg", "792575729bbcc2e5ede8d056dc4c3187e4842a5c19cb7657f4f44d1e0a3f6101", "copy"],
  ["Title-Paper-Editor-Dawn.svg", "f665b28854ed1daf211ea5057c3d3ab76c8a5e852c7f15dce800e6218b302d3d", "stretch-menu-paper"],
  ["Title-Paper-Editor-StarNight.svg", "9f4eb09c7dc0ffae0ed0b455086897de6d621aeffc1d407e8afa58df55422c04", "stretch-menu-paper"]
];

const platformAssets = [
  ["platform-chatgpt.svg", "openai.svg", "a595df6b423920c67a7f8f73c063e4bfb72d415948097b6cac063a2366bb5186", "clean-svg"],
  ["platform-claude.svg", "claude-color.svg", "f59a4df4ec4c414f04e3697bff037e270702ceadc5f8d50f8c3df28d926b3fa8", "clean-svg"],
  ["platform-gemini.svg", "gemini-color.svg", "8ab0a9bafec11f7e69bcb9fc4ffd8f1bc927d1ddcbbb6ff36dee5ae8b5a9d602", "clean-svg"],
  ["platform-grok.svg", "grok.svg", "9175fc90c22655160231976c849f25a03b888d7cc0e04c5f1b987b659bb07c95", "clean-svg"],
  ["platform-deepseek.svg", "deepseek-color.svg", "233b3a4bf5dbefc3a5c7384bf32af474ed6b0f40e84c1283f752dc971c5bc999", "clean-svg"],
  ["platform-doubao.png", "04_豆包.png", "f379110c25f32af7fa4b4dd87bf2e55f03bf06f237819ab8c72a6c9eda3a448a", "copy"],
  ["platform-qwen.svg", "qwen-color.svg", "77f5768c66d08ce1d3d14e73373975c1bc0454be88c81523ddd0ffd7e2974029", "clean-svg"],
  ["platform-chatglm.svg", "qingyan-color.svg", "fc4c9dc628acbfdc18626fd04ae3192f049faf894ad2e342c84338f6ecfe7741", "clean-svg"],
  ["platform-yuanbao.svg", "yuanbao-color.svg", "522b9c3ee6f4136b3dd2f5e844a2273b6d599ae614329dbcaf96c74375b0fdd5", "clean-svg"],
  ["platform-zai.svg", "zai.svg", "e748cb5108ce37b116d7a5ba97d37e0ae97eadf6849b0de11afb248e244a01e1", "clean-svg"],
  ["platform-kimi.svg", "kimi-color.svg", "74a7292aeb0220445d14c5d397d75760e2e8c6ed6a9e5fe4f3023471bf62a9ff", "clean-svg"],
  ["platform-mistral.svg", "mistral-color.svg", "722f74b289d95486b43662fe24fa883b333701296f618406cd0ed502299170b6", "clean-svg"]
];

const acceptedDerivatives = [
  ["AllDirectory-Selected-Dawn.svg", "bca13a8a0eb840aa497644adbf5c753aaa15ce69862d3c940b6181a858480c11", "91a61bfa555f442ffd33e79a20593d19407aa488b6264ea268f77b797f3a9ae7"],
  ["AllDirectory-Selected-StarNight.svg", "78b40337814c9f19cefb000545920aa575433e182491501e66e64128f381743e", "164f4e980faf8baa1ba0d231522c57bccbfea0f803698f0be4af1a3304b35d69"],
  ["AllDirectory-UnSelected-Dawn.svg", "955e16376f72bb259be13410ed9f41229c725d5629f69ba0c83ad91af10a6e53", "176567caafd5d2a9c81ed5d1885dc1377342e82cdee71a1bbec3d701171a7c20"],
  ["AllDirectory-UnSelected-StarNight.svg", "3e0d9c59ce2df198831e315af19ded1f9b07fe1eb6021e2e50379f2604f42c53", "ab9b7c15b3875ccfa035071b5492ca0d0ead84b01a007c812969f53dd8c8df67"],
  ["Directory-Selected-Dawn-01.svg", "52e84a9d6962618f58a3cbf94cfd573e119c1eb34882ec17e1be2b0592831b00", "4ba934709abcbbab7ae660a4bfbe0dd0b81ff589b1c5621fc6cd583f2daaeaba"],
  ["Directory-Selected-Dawn-02.svg", "f4c59e2e2f786f763364bc5d8a9e12a5ef96e44b68422346d6b1e01b64b2d59e", "1a196373b791aeb014b0a71926cf792fcd4341ae2b0bc00e36cdaa0f26e0d7c7"],
  ["Directory-Selected-Dawn-03.svg", "0a27ab8e89c2a93ec5f3831a84a855d8a202341ee6f04b9281839ad43442d6b9", "5b827f73e1e85f40892af675adfde43154c741d0fe1fb9eb278caf632f55e7ee"],
  ["Directory-Selected-Dawn-04.svg", "378e1bb183a337316c6a55e6886dc1bf05f3581e1e4250b4da0a0e91ad253a51", "7d1e7c1a7b9e25f297f7904659bf9eecc4f59a3a490feca85469179fa1b91ee3"],
  ["Directory-Selected-StarNight-01.svg", "1af455fd6a703a0645f894234008ac7d7e4d067b8511800e0feb8d4bf42a350d", "bf93cc00f3df961393d8d356a73f24c11a777142c68ef1bdb86c424a9fea8976"],
  ["Directory-Selected-StarNight-02.svg", "5730933ec323cfa1e34db32d17c39a28fa92c8b2d395cc427c72d5fea9c8a531", "b1df5af61af19b10222917e6fddc362a8029304ab33c785fc8345dc945469364"],
  ["Directory-Selected-StarNight-03.svg", "fbc087dfc3d1382b9978b4b6a55f2a4444d3d3454b72a65180a60f376381a0c6", "7038ff4df1453225a91d7196ac34dca17fc344854c7edec2873b06b3a9cbec98"],
  ["Directory-Selected-StarNight-04.svg", "2b7d80f11e84b6e8ac8ac149ebe8fa75b2beee8e8f701e70924610ade34e5a92", "df05bd9f68ab9cd454272ef0ad8dca01b1cdad96140e21ecd9b5ae485f6d21da"],
  ["Directory-UnSelected-Dawn-01.svg", "47f213000ea0bd9ece0b99a070ff2810d719e82b5a31b9c28d1d822a2fc31c0b", "73cb17dcc43e986acc3d16099bb9df249a3474a4920fff7322488b04da655b61"],
  ["Directory-UnSelected-Dawn-02.svg", "4012019c5c43b964d41f55a8716dfb268d492483b83c6b5788fc837f2706148c", "900fad9d71c6975c40501fdf1faacaa2a06271cfd37cca7c99e42e64d92e2fb3"],
  ["Directory-UnSelected-StarNight-01.svg", "1f90650a24c3145835f036ac85f7a08d799f5b61c99f6a94f16950858f15ee7b", "c5c9cb5307bf6b938ae2b1a3edf23581f7e028f02e8bcf6c5f3aec543c99647c"],
  ["Directory-UnSelected-StarNight-02.svg", "589f83a61af637a17d417bc80bf150cdeeec179d854c3825a89b81193b4a0fd8", "4820c9c65069310946ff2db5677a93fb2ac54ba28910e88d7c74f0a696798681"],
  ["ThreeBird-Dawn.svg", "8c55d8a4cd6271ce3108c6842a587874176ba4fefe75799c3461aeb67c1b3947", "ede75fe1856a181b563abe7bfd0a645bcdd082f77952b45aa58dab74df78f4c3"],
  ["ThreeBird-StarNight.svg", "bb802f64464cff5d66a08af32bd5aec590921d85083e8c76175965a5215476ab", "d2b181f0cb78ab57e8e1aaefcaff61d709f59890020f81287de9b46b96872e35"],
  ["RCSD-爬相框的猫.svg", "7880e11f049f7108f2109e6bc5689c95c17b351eea4b66750235af56cdae5f20", "a31498b9bf45dcf13138a09d317c05d0ddb1a1e6045ae8dbd89439a4a3994c84"],
  ["RCSS-鹦鹉.svg", "73acc9947529456e50d91da1dd3971b13a78a36fb8d49ade9636a094791df8a9", "33062bc4fce566a3e0b465f8c91cb9637765d2b39c7bde6b8fb397ca672b36b8"]
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanSvg(value) {
  return value
    .replace(/\s+data-name="[^"]*"/gu, "")
    .replace(/\s+id="_(?:图层|采云|相框)[^"]*"/gu, "")
    .replace(/<metadata\b[\s\S]*?<\/metadata>/giu, "")
    .replace(/\r\n/gu, "\n");
}

await mkdir(outputRoot, { recursive: true });
const manifest = [];
for (const [name, expected, transform] of assets) {
  const sourcePath = path.join(designRoot, name);
  const source = await readFile(sourcePath);
  assert.equal(sha256(source), expected, `Design source changed: ${name}`);
  const output = transform === "clean-svg"
    ? Buffer.from(cleanSvg(source.toString("utf8")), "utf8")
    : source;
  await writeFile(path.join(outputRoot, name), output);
  manifest.push({
    output: `welcome/${name}`,
    source: `阅读器美术素材/Cloudig-Image/${name}`,
    source_sha256: expected,
    transform,
    output_sha256: sha256(output)
  });
}
const readerOutputRoot = path.join(assetRoot, "reader");
await mkdir(readerOutputRoot, { recursive: true });
for (const [name, expected, transform] of readerAssets) {
  const sourcePath = path.join(designRoot, name);
  const source = await readFile(sourcePath);
  assert.equal(sha256(source), expected, `Design source changed: ${name}`);
  const output = transform === "stretch-title-background"
    ? Buffer.from(cleanSvg(source.toString("utf8")).replace("<svg ", '<svg preserveAspectRatio="none" '), "utf8")
    : transform === "clean-svg" ? Buffer.from(cleanSvg(source.toString("utf8")), "utf8") : source;
  await writeFile(path.join(readerOutputRoot, name), output);
  manifest.push({
    output: `reader/${name}`,
    source: `阅读器美术素材/Cloudig-Image/${name}`,
    source_sha256: expected,
    transform,
    output_sha256: sha256(output)
  });
}
const archiverOutputRoot = path.join(assetRoot, "archiver");
await mkdir(archiverOutputRoot, { recursive: true });
for (const [name, expected, transform] of archiverAssets) {
  const sourcePath = path.join(designRoot, name);
  const source = await readFile(sourcePath);
  assert.equal(sha256(source), expected, `Design source changed: ${name}`);
  const output = transform === "clean-svg" ? Buffer.from(cleanSvg(source.toString("utf8")), "utf8") : source;
  await writeFile(path.join(archiverOutputRoot, name), output);
  manifest.push({
    output: `archiver/${name}`,
    source: `阅读器美术素材/Cloudig-Image/${name}`,
    source_sha256: expected,
    transform,
    output_sha256: sha256(output)
  });
}
for (const [name, upstream, expected] of acceptedArchiverDerivatives) {
  const upstreamSource = await readFile(path.join(designRoot, name));
  assert.equal(sha256(upstreamSource), upstream, `Accepted Archiver derivative upstream changed: ${name}`);
  const source = await readFile(path.join(acceptedArchiverDerivativeRoot, name));
  assert.equal(sha256(source), expected, `Accepted Archiver derivative changed: ${name}`);
  const motionPath = "AIChatArchive/src/ui/shell/pages/archiver/rooster-motion.css";
  const motion = await readFile(path.resolve(repository, "..", motionPath));
  const motionBlock = /\/\* Cloudig animation derivative:[\s\S]*?(?=<\/style>)/u;
  assert.match(source.toString("utf8"), motionBlock, "The frozen rooster animation boundary changed");
  const output = Buffer.from(source.toString("utf8").replace(motionBlock, `${motion.toString("utf8")}\n    `));
  await writeFile(path.join(archiverOutputRoot, name), output);
  manifest.push({
    output: `archiver/${name}`,
    source: `AIChatArchive/ui/assets/archiver/${name}`,
    source_sha256: expected,
    upstream: `阅读器美术素材/Cloudig-Image/${name}`,
    upstream_sha256: upstream,
    transform: "rooster-detail-motion",
    motion_source: motionPath,
    motion_sha256: sha256(motion),
    output_sha256: sha256(output)
  });
}
const editorOutputRoot = path.join(assetRoot, "editor");
await mkdir(editorOutputRoot, { recursive: true });
for (const [name, expected, transform] of editorAssets) {
  const sourcePath = path.join(designRoot, name);
  const source = await readFile(sourcePath);
  assert.equal(sha256(source), expected, `Editor source changed: ${name}`);
  // The paper must fill its CSS panel; SVG's default "meet" otherwise adds
  // invisible side gutters and makes the actual paper edge swallow the padding.
  const output = transform === "stretch-menu-paper"
    ? Buffer.from(source.toString("utf8").replace("<svg ", '<svg preserveAspectRatio="none" '), "utf8")
    : source;
  await writeFile(path.join(editorOutputRoot, name), output);
  manifest.push({
    output: `editor/${name}`,
    source: `阅读器美术素材/Cloudig-Image/${name}`,
    source_sha256: expected,
    transform,
    output_sha256: sha256(output)
  });
}
for (const [name, upstream, expected] of acceptedDerivatives) {
  const upstreamSource = await readFile(path.join(designRoot, name));
  assert.equal(sha256(upstreamSource), upstream, `Accepted derivative upstream changed: ${name}`);
  const source = await readFile(path.join(acceptedDerivativeRoot, name));
  assert.equal(sha256(source), expected, `Accepted derivative changed: ${name}`);
  await writeFile(path.join(readerOutputRoot, name), source);
  manifest.push({
    output: `reader/${name}`,
    source: `AIChatArchive/reader/assets/cover/${name}`,
    source_sha256: expected,
    upstream: `阅读器美术素材/Cloudig-Image/${name}`,
    upstream_sha256: upstream,
    transform: "accepted-derivative",
    output_sha256: expected
  });
}
const foreground = await readFile(path.join(acceptedDerivativeRoot, "Dawn-Window-Foreground.png"));
assert.equal(sha256(foreground), "30bf31b4e40b38f1c96aa03d4796c75fae3c591b96f3067f40f366e346566a5d");
await writeFile(path.join(readerOutputRoot, "Dawn-Window-Foreground.png"), foreground);
manifest.push({
  output: "reader/Dawn-Window-Foreground.png",
  source: "AIChatArchive/reader/assets/cover/Dawn-Window-Foreground.png",
  source_sha256: "30bf31b4e40b38f1c96aa03d4796c75fae3c591b96f3067f40f366e346566a5d",
  upstream: "阅读器美术素材/Cloudig-Image/Cloudig-Reader-Cover-Scene-Dawn.png + RCSD-破晓窗户.svg",
  upstream_sha256: "184a6ec8063d85acecca9d4f40360356d895d5ec09c025e937ff3dca6fe47097+a50ce6020172a53bf5a8100640c8223caa6ada529f19c3d3b67082dc426d758f",
  transform: "accepted-window-foreground",
  output_sha256: "30bf31b4e40b38f1c96aa03d4796c75fae3c591b96f3067f40f366e346566a5d"
});
const platformOutputRoot = path.join(assetRoot, "platforms");
await mkdir(platformOutputRoot, { recursive: true });
for (const [outputName, sourceName, expected, transform] of platformAssets) {
  const source = await readFile(path.join(iconRoot, sourceName));
  assert.equal(sha256(source), expected, `Platform source changed: ${sourceName}`);
  const output = transform === "clean-svg" ? Buffer.from(cleanSvg(source.toString("utf8")), "utf8") : source;
  await writeFile(path.join(platformOutputRoot, outputName), output);
  manifest.push({
    output: `platforms/${outputName}`,
    source: `阅读器美术素材/AI-Icon/${sourceName}`,
    source_sha256: expected,
    transform,
    output_sha256: sha256(output)
  });
}
for (const [input, outputName] of [["codex.svg", "platform-codex.svg"], ["LICENSE.txt", "Codex-LICENSE.txt"]]) {
  const source = `src/ui/vendor/lobe-icons/${input}`, bytes = await readFile(path.join(repository, source));
  await writeFile(path.join(platformOutputRoot, outputName), bytes);
  manifest.push({ output: `platforms/${outputName}`, source: `AIChatArchive/${source}`, source_sha256: sha256(bytes), transform: "copy", output_sha256: sha256(bytes) });
}
for (const [input, outputName, expected] of [
  ["platform-cline.svg", "platform-cline.svg", "6aab009bf089a8dc1b5452c05c471244a08595b78fd639835eacc0821b887c06"],
  ["platform-sillytavern.svg", "platform-sillytavern.svg", "f781779749f4903d20380a1d957b0bad679e57c76c392ee83282bda844d5dba0"],
  ["platform-kimi-code.svg", "platform-kimi-code.svg", "74a7292aeb0220445d14c5d397d75760e2e8c6ed6a9e5fe4f3023471bf62a9ff"],
  ["platform-claude-code.svg", "platform-claude-code.svg", "41f97213faf9c00f763e8fc5e968f109fb389934e262221388390249b8d8f74f"],
  ["platform-agent-instance.svg", "platform-agent-instance.svg", "bebc1102fdf5be462af286fbdf83087bad1c0c9855ed40d499102ff6f533c0e8"]
]) {
  const source = `AIChatArchive/src/ui/assets/platforms/${input}`, bytes = await readFile(path.join(repository, "src/ui/assets/platforms", input));
  assert.equal(sha256(bytes), expected, `Agent platform source changed: ${input}`);
  await writeFile(path.join(platformOutputRoot, outputName), bytes);
  manifest.push({ output: `platforms/${outputName}`, source, source_sha256: expected, transform: "copy", output_sha256: expected });
}
await writeFile(
  path.join(assetRoot, "asset-sources.json"),
  `${JSON.stringify({ schema: "cloudig/asset-sources/1.0.0", assets: manifest }, null, 2)}\n`,
  "utf8"
);
console.log(JSON.stringify({ assets: manifest.length }));
