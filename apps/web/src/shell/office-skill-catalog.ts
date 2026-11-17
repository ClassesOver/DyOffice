import {parseSkillFrontmatter} from '@genoffice/agent-core'
import descriptions from '../../../../skills/recommended/locales/zh.json'
import {classifyOfficeSkill} from './office-skills'

import budgetPlanner from '../../../../skills/recommended/budget-planner/SKILL.md?raw'
import businessPlan from '../../../../skills/recommended/business-plan/SKILL.md?raw'
import businessReport from '../../../../skills/recommended/business-report/SKILL.md?raw'
import campaignPlanner from '../../../../skills/recommended/campaign-planner/SKILL.md?raw'
import contractDrafter from '../../../../skills/recommended/contract-drafter/SKILL.md?raw'
import courseSlides from '../../../../skills/recommended/course-slides/SKILL.md?raw'
import dataAnalyst from '../../../../skills/recommended/data-analyst/SKILL.md?raw'
import dataCleaning from '../../../../skills/recommended/data-cleaning/SKILL.md?raw'
import deepResearch from '../../../../skills/recommended/deep-research/SKILL.md?raw'
import executiveDeck from '../../../../skills/recommended/executive-deck/SKILL.md?raw'
import expenseReport from '../../../../skills/recommended/expense-report/SKILL.md?raw'
import financialStatementAnalysis from '../../../../skills/recommended/financial-statement-analysis/SKILL.md?raw'
import invoiceTaxChecklist from '../../../../skills/recommended/invoice-tax-checklist/SKILL.md?raw'
import jobDescription from '../../../../skills/recommended/job-description/SKILL.md?raw'
import kpiDashboard from '../../../../skills/recommended/kpi-dashboard/SKILL.md?raw'
import laborContract from '../../../../skills/recommended/labor-contract/SKILL.md?raw'
import lessonPlan from '../../../../skills/recommended/lesson-plan/SKILL.md?raw'
import meetingMinutes from '../../../../skills/recommended/meeting-minutes/SKILL.md?raw'
import ndaDrafter from '../../../../skills/recommended/nda-drafter/SKILL.md?raw'
import okrPlanner from '../../../../skills/recommended/okr-planner/SKILL.md?raw'
import onboardingPlan from '../../../../skills/recommended/onboarding-plan/SKILL.md?raw'
import performanceReview from '../../../../skills/recommended/performance-review/SKILL.md?raw'
import personalFinance from '../../../../skills/recommended/personal-finance/SKILL.md?raw'
import policyCompliance from '../../../../skills/recommended/policy-compliance/SKILL.md?raw'
import productLaunch from '../../../../skills/recommended/product-launch/SKILL.md?raw'
import proposalWriter from '../../../../skills/recommended/proposal-writer/SKILL.md?raw'
import quizMaker from '../../../../skills/recommended/quiz-maker/SKILL.md?raw'
import resumePolisher from '../../../../skills/recommended/resume-polisher/SKILL.md?raw'
import salesForecast from '../../../../skills/recommended/sales-forecast/SKILL.md?raw'
import slidePlanner from '../../../../skills/recommended/slide-planner/SKILL.md?raw'
import sopWriter from '../../../../skills/recommended/sop-writer/SKILL.md?raw'
import studyPlan from '../../../../skills/recommended/study-plan/SKILL.md?raw'
import surveyAnalyst from '../../../../skills/recommended/survey-analyst/SKILL.md?raw'
import swotStrategy from '../../../../skills/recommended/swot-strategy/SKILL.md?raw'
import termsOfService from '../../../../skills/recommended/terms-of-service/SKILL.md?raw'
import thesisAdvisor from '../../../../skills/recommended/thesis-advisor/SKILL.md?raw'
import weeklyReport from '../../../../skills/recommended/weekly-report/SKILL.md?raw'

// Keep browser dependencies literal so the boundary gate can inspect every resource.
// Reuse DyOffice task resources; importing a catalog never installs account records.
const sources = [
  budgetPlanner,
  businessPlan,
  businessReport,
  campaignPlanner,
  contractDrafter,
  courseSlides,
  dataAnalyst,
  dataCleaning,
  deepResearch,
  executiveDeck,
  expenseReport,
  financialStatementAnalysis,
  invoiceTaxChecklist,
  jobDescription,
  kpiDashboard,
  laborContract,
  lessonPlan,
  meetingMinutes,
  ndaDrafter,
  okrPlanner,
  onboardingPlan,
  performanceReview,
  personalFinance,
  policyCompliance,
  productLaunch,
  proposalWriter,
  quizMaker,
  resumePolisher,
  salesForecast,
  slidePlanner,
  sopWriter,
  studyPlan,
  surveyAnalyst,
  swotStrategy,
  termsOfService,
  thesisAdvisor,
  weeklyReport,
]
const names: Record<string,string> = {
 'budget-planner':'预算规划','business-plan':'商业计划书','business-report':'商务报告','campaign-planner':'活动策划','contract-drafter':'合同起草','course-slides':'教学课件','data-analyst':'数据分析','data-cleaning':'数据清洗','deep-research':'深度调研','executive-deck':'管理汇报','expense-report':'费用报销','financial-statement-analysis':'财务报表分析','invoice-tax-checklist':'开票与税务核对','job-description':'职位说明','kpi-dashboard':'KPI 看板','labor-contract':'劳动合同','lesson-plan':'教案设计','meeting-minutes':'会议纪要','nda-drafter':'保密协议','okr-planner':'OKR 规划','onboarding-plan':'入职计划','performance-review':'绩效评估','personal-finance':'个人财务规划','policy-compliance':'合规制度','product-launch':'产品发布','proposal-writer':'方案建议书','quiz-maker':'试卷命制','resume-polisher':'简历优化','sales-forecast':'销售预测','slide-planner':'演示策划','sop-writer':'操作规程','study-plan':'学习计划','survey-analyst':'问卷分析','swot-strategy':'战略分析','terms-of-service':'服务条款','thesis-advisor':'论文指导','weekly-report':'周报与月报',
}
const webBoundary = `

## Web 工具适配

仅使用当前会话实际提供且已授权的工具，不调用桌面终端、CLI 或安装程序。
先核实当前编辑器是否支持本任务需要的读取、编辑和保存操作；Word 通过已提供的文档工具操作，Excel、PowerPoint 和 PDF 没有写工具时仅在回复中整理分析或提纲，不声称已创建或修改文件。
只有收到实际保存成功的结果，才能报告文件已保存。结果未确认时如实说明，不自动重复写入。
`
export const WEB_OFFICE_SKILL_CATALOG = sources.flatMap(source => {
 const parsed = parseSkillFrontmatter(source)
 if (!parsed) return []
 const classification = classifyOfficeSkill(parsed.name, parsed.description, parsed.body)
 if (!classification.relevant) return []
 return [{key:parsed.name,name:names[parsed.name]??parsed.name,description:(descriptions as Record<string,string>)[parsed.name]??parsed.description,source:source.trimEnd()+webBoundary,formats:classification.matched}]
}).sort((a,b)=>a.key.localeCompare(b.key))
