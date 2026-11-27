// Writes TheoremDesk's LaTeX templates (one folder each, with template.json,
// main.tex, references.bib and dot-gitignore) into the core extension's
// latex-templates/. Edit templates here, then regenerate:
//
//   node theoremdesk/tools/make_latex_templates.js theoremdesk/extensions/theoremdesk-core/latex-templates
//
// Add each template's TeX Live packages to tools/tex-packages.txt; the offline
// test compiles every template.
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];

const BIB = `@article{einstein1905,
  author  = {Einstein, Albert},
  title   = {Zur Elektrodynamik bewegter K{\\"o}rper},
  journal = {Annalen der Physik},
  volume  = {322},
  number  = {10},
  pages   = {891--921},
  year    = {1905},
  doi     = {10.1002/andp.19053221004}
}

@book{lamport1994,
  author    = {Lamport, Leslie},
  title     = {{\\LaTeX}: A Document Preparation System},
  edition   = {2nd},
  publisher = {Addison-Wesley},
  year      = {1994}
}
`;

const BODY = `\\section{Introduction}
Write your introduction here. Cite sources from \\texttt{references.bib} like
this~\\cite{einstein1905}, and see the \\LaTeX{} manual~\\cite{lamport1994}.

\\section{Results}
Number important equations so you can refer to them:
\\begin{equation}
  E = mc^2 . \\label{eq:energy}
\\end{equation}
Equation~\\eqref{eq:energy} relates energy and mass.

\\section{Conclusion}
Summarise what you found.
`;

const CHAPTERS = `\\chapter{Introduction}
Write your introduction here. Cite sources from \\texttt{references.bib} like
this~\\cite{einstein1905}, and see the \\LaTeX{} manual~\\cite{lamport1994}.

\\chapter{Background}
\\section{Notation}
Number important equations so you can refer to them:
\\begin{equation}
  E = mc^2 . \\label{eq:energy}
\\end{equation}

\\chapter{Conclusion}
Summarise the thesis and what comes next.
`;

const ABSTRACT = 'Write a short summary of the question, the method and the main result.';

const templates = [
	// --- Research papers -----------------------------------------------------
	{
		id: 'ams-article', category: 'Research papers', label: 'Mathematics article (AMS)',
		description: 'amsart: theorem environments, AMS style for journals in mathematics.',
		packages: [], bibstyle: 'amsplain', title: 'A Theorem About Something',
		tex: `\\documentclass{amsart}
\\usepackage{amssymb}
\\usepackage[hidelinks]{hyperref}

\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
\\theoremstyle{definition}
\\newtheorem{definition}[theorem]{Definition}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\address{Department, University, City, Country}
\\email{author@example.org}
\\date{\\today}

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\maketitle

${BODY}
\\begin{theorem}\\label{thm:main}
State the main result here.
\\end{theorem}

\\begin{proof}
Prove it here.
\\end{proof}

\\bibliographystyle{amsplain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'aps-revtex', category: 'Research papers', label: 'Physics paper: APS journals (REVTeX 4.2)',
		description: 'Physical Review Letters, Physical Review A-E, X and Applied. Switch prl to pra, prb, ... in the class options.',
		packages: ['revtex'], bibstyle: 'apsrev4-2', title: 'A Letter About Something',
		tex: `\\documentclass[aps,prl,reprint,superscriptaddress]{revtex4-2}
\\usepackage{amsmath}
\\usepackage[hidelinks]{hyperref}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\affiliation{Department of Physics, University, City, Country}
\\date{\\today}

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\maketitle

${BODY}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'arxiv-preprint', category: 'Research papers', label: 'arXiv preprint',
		description: 'A clean article for posting to arXiv before (or instead of) journal formatting.',
		packages: [], bibstyle: 'unsrtnat', title: 'A Preprint About Something',
		tex: `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage[numbers]{natbib}
\\usepackage[hidelinks]{hyperref}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}\\\\ \\small Department, University \\\\ \\small \\texttt{author@example.org}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

${BODY}
\\bibliographystyle{unsrtnat}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'elsevier', category: 'Research papers', label: 'Elsevier journal (elsarticle)',
		description: 'Physics Letters B, Nuclear Physics B, Journal of Computational Physics and other Elsevier journals.',
		packages: ['elsarticle'], bibstyle: 'elsarticle-num', title: 'An Article About Something',
		tex: `\\documentclass[preprint,12pt]{elsarticle}
\\usepackage{amsmath,amssymb}
\\usepackage[hidelinks]{hyperref}

\\journal{Journal Name}

\\begin{document}

\\begin{frontmatter}
\\title{{{PROJECT_TITLE}}}
\\author[1]{{{AUTHOR}}}
\\affiliation[1]{organization={Department, University},
  city={City},
  country={Country}}

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\begin{keyword}
first keyword \\sep second keyword
\\end{keyword}
\\end{frontmatter}

${BODY}
\\bibliographystyle{elsarticle-num}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'mnras', category: 'Research papers', label: 'Astronomy: Monthly Notices of the RAS',
		description: 'The MNRAS class, with author-year citations.',
		packages: ['mnras'], bibstyle: 'mnras', title: 'A Study of Something',
		tex: `\\documentclass[fleqn,usenatbib]{mnras}
\\usepackage{amsmath}

\\title[Short title]{{{PROJECT_TITLE}}}
\\author[{{AUTHOR}}]{{{AUTHOR}}$^{1}$\\thanks{E-mail: author@example.org}
\\\\
$^{1}$Department, University, City, Country}
\\date{Accepted XXX. Received YYY; in original form ZZZ}
\\pubyear{{{YEAR}}}

\\begin{document}
\\label{firstpage}
\\pagerange{\\pageref{firstpage}--\\pageref{lastpage}}
\\maketitle

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\begin{keywords}
keyword one -- keyword two
\\end{keywords}

${BODY.replace('like\nthis~\\cite{einstein1905}', 'like\nthis: \\citet{einstein1905}')}
\\bibliographystyle{mnras}
\\bibliography{references}

\\bsp
\\label{lastpage}
\\end{document}
`,
	},
	// --- Conference papers ---------------------------------------------------
	{
		id: 'ieee-conference', category: 'Conference papers', label: 'IEEE conference',
		description: 'IEEEtran in conference mode, with IEEE reference style.',
		packages: ['ieeetran'], bibstyle: 'IEEEtran', title: 'A Conference Paper About Something',
		tex: `\\documentclass[conference]{IEEEtran}
\\usepackage{amsmath,amssymb}
\\usepackage{cite}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\author{\\IEEEauthorblockN{{{AUTHOR}}}
\\IEEEauthorblockA{Department, University\\\\
City, Country\\\\
author@example.org}}

\\maketitle

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\begin{IEEEkeywords}
first keyword, second keyword
\\end{IEEEkeywords}

${BODY}
\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'acm-sigconf', category: 'Conference papers', label: 'ACM conference (acmart sigconf)',
		description: 'ACM proceedings format, with ACM reference style.',
		packages: ['acmart'], bibstyle: 'ACM-Reference-Format', title: 'A Conference Paper About Something',
		tex: `\\documentclass[sigconf,nonacm]{acmart}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\affiliation{%
  \\institution{University}
  \\city{City}
  \\country{Country}}
\\email{author@example.org}

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\keywords{first keyword, second keyword}

\\maketitle

${BODY}
\\bibliographystyle{ACM-Reference-Format}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'springer-lncs', category: 'Conference papers', label: 'Springer LNCS',
		description: 'Lecture Notes in Computer Science, used by many conferences.',
		packages: ['llncs'], bibstyle: 'splncs04', title: 'A Conference Paper About Something',
		tex: `\\documentclass[runningheads]{llncs}
\\usepackage{amsmath}
\\usepackage[hidelinks]{hyperref}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\institute{Department, University, City, Country\\\\
\\email{author@example.org}}

\\maketitle

\\begin{abstract}
${ABSTRACT}
\\keywords{First keyword \\and Second keyword.}
\\end{abstract}

${BODY}
\\bibliographystyle{splncs04}
\\bibliography{references}

\\end{document}
`,
	},
	// --- Talks and posters ---------------------------------------------------
	{
		id: 'beamer-talk', category: 'Talks and posters', label: 'Talk slides (Beamer, Metropolis theme)',
		description: 'A clean, modern slide deck for seminars and conference talks.',
		packages: ['beamer', 'beamertheme-metropolis'], bibstyle: 'plain', title: 'A Talk About Something',
		tex: `\\documentclass[aspectratio=169]{beamer}
\\usetheme{metropolis}
\\usepackage{amsmath}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\institute{Department, University}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Motivation}
\\begin{frame}{The question}
  \\begin{itemize}
    \\item What problem are we solving?
    \\item Why does it matter?~\\cite{einstein1905}
  \\end{itemize}
\\end{frame}

\\section{Results}
\\begin{frame}{Main result}
  \\begin{equation*}
    E = mc^2
  \\end{equation*}
\\end{frame}

\\begin{frame}{References}
  \\bibliographystyle{plain}
  \\bibliography{references}
\\end{frame}

\\end{document}
`,
	},
	{
		id: 'poster', category: 'Talks and posters', label: 'Conference poster (tikzposter)',
		description: 'An A0 portrait poster with titled blocks.',
		packages: ['tikzposter'], bibstyle: 'plain', title: 'A Poster About Something',
		tex: `\\documentclass[25pt,a0paper,portrait]{tikzposter}
\\usepackage{amsmath}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\institute{Department, University}
\\usetheme{Simple}

\\begin{document}

\\maketitle

\\begin{columns}
  \\column{0.5}
  \\block{Introduction}{
    State the question and why it matters~\\cite{einstein1905}.
  }
  \\block{Method}{
    \\begin{equation*}
      E = mc^2
    \\end{equation*}
  }
  \\column{0.5}
  \\block{Results}{
    Show the main result.
  }
  \\block{References}{
    \\renewcommand{\\section}[2]{}
    \\bibliographystyle{plain}
    \\bibliography{references}
  }
\\end{columns}

\\end{document}
`,
	},
	// --- Theses ---------------------------------------------------------------
	{
		id: 'thesis-generic', category: 'Theses', label: 'Thesis (any university)',
		description: 'A standard report-class thesis: title page, abstract, acknowledgements, contents, chapters.',
		packages: [], bibstyle: 'plain', title: 'Thesis Title',
		tex: `\\documentclass[12pt,oneside]{report}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage[hidelinks]{hyperref}

\\begin{document}

\\begin{titlepage}
  \\centering
  {\\LARGE\\bfseries {{PROJECT_TITLE}}\\par}
  \\vspace{2cm}
  {\\Large {{AUTHOR}}\\par}
  \\vfill
  A thesis submitted for the degree of\\\\
  \\emph{Doctor of Philosophy}\\\\[1ex]
  Department, University\\\\[1ex]
  {{YEAR}}
\\end{titlepage}

\\pagenumbering{roman}
\\chapter*{Abstract}
${ABSTRACT}

\\chapter*{Acknowledgements}
Thank the people who helped.

\\tableofcontents
\\cleardoublepage
\\pagenumbering{arabic}

${CHAPTERS}
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'thesis-hepthesis', category: 'Theses', label: 'Physics PhD thesis (hepthesis)',
		description: 'A thesis class designed for physics PhDs, from high-energy physics.',
		packages: ['hepthesis'], bibstyle: 'plain', title: 'Thesis Title',
		tex: `\\documentclass[oneside]{hepthesis}
\\usepackage{lmodern}% scalable fonts, which hepthesis's microtype needs
\\usepackage{amsmath}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\date{{{YEAR}}}

\\begin{document}

\\begin{frontmatter}
  \\titlepage[Department of Physics]{A thesis submitted for the degree of Doctor of Philosophy}
  \\begin{abstract}
    ${ABSTRACT}
  \\end{abstract}
  \\tableofcontents
\\end{frontmatter}

\\begin{mainmatter}
${CHAPTERS}
\\end{mainmatter}

\\begin{backmatter}
  \\bibliographystyle{plain}
  \\bibliography{references}
\\end{backmatter}

\\end{document}
`,
	},
	{
		id: 'thesis-mit', category: 'Theses', label: 'MIT thesis (mitthesis)',
		description: "Formatted to MIT Libraries' thesis requirements.",
		packages: ['mitthesis'], bibstyle: 'plain', title: 'Thesis Title',
		tex: `\\DocumentMetadata{lang=en-US, pdfversion=1.7}
\\documentclass[twoside]{mitthesis}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\Author{{{AUTHOR}}}{Department of Physics}
\\Degree{Doctor of Philosophy in Physics}{Department of Physics}
\\Supervisor{Supervisor Name}{Professor of Physics}
\\Acceptor{Acceptor Name}{Professor of Physics}{Graduate Officer, Department of Physics}
\\DegreeDate{May}{{{YEAR}}}
\\ThesisDate{May 1, {{YEAR}}}

\\maketitle

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\tableofcontents

${CHAPTERS}
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'thesis-berkeley', category: 'Theses', label: 'UC Berkeley dissertation (ucbthesis)',
		description: 'Formatted to UC Berkeley Graduate Division requirements.',
		packages: ['ucbthesis'], bibstyle: 'plain', title: 'Dissertation Title',
		tex: `\\documentclass{ucbthesis}
\\usepackage{amsmath}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\degreesemester{Spring}
\\degreeyear{{{YEAR}}}
\\degree{Doctor of Philosophy}
\\chair{Professor Chair Name}
\\othermembers{Professor Member One \\\\
  Professor Member Two}
\\numberofmembers{3}
\\field{Physics}

\\maketitle
\\approvalpage
\\copyrightpage

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\begin{frontmatter}
\\tableofcontents
\\begin{acknowledgements}
Thank the people who helped.
\\end{acknowledgements}
\\end{frontmatter}

\\pagestyle{headings}
${CHAPTERS}
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'thesis-toronto', category: 'Theses', label: 'University of Toronto thesis (ut-thesis)',
		description: 'Formatted to the School of Graduate Studies requirements.',
		packages: ['ut-thesis'], bibstyle: 'plain', title: 'Thesis Title',
		tex: `\\documentclass[12pt]{ut-thesis}
\\usepackage{amsmath}

\\author{{{AUTHOR}}}
\\title{{{PROJECT_TITLE}}}
\\degree{Doctor of Philosophy}
\\department{Physics}
\\gradyear{{{YEAR}}}

\\begin{document}

\\frontmatter
\\maketitle

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\tableofcontents

\\mainmatter
${CHAPTERS}
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'thesis-washington', category: 'Theses', label: 'University of Washington thesis (uwthesis)',
		description: 'Formatted to the UW Graduate School requirements.',
		packages: ['uwthesis'], bibstyle: 'plain', title: 'Thesis Title',
		tex: `\\documentclass[11pt,twoside]{uwthesis}
\\usepackage{amsmath}

\\begin{document}

\\prelimpages

\\Title{{{PROJECT_TITLE}}}
\\Author{{{AUTHOR}}}
\\Year{{{YEAR}}}
\\Program{Physics}
\\Chair{Chair Name}{Professor}{Department of Physics}
\\Signature{Committee Member}
\\Signature{Committee Member}
\\titlepage

\\abstract{%
${ABSTRACT}
}

\\tableofcontents

\\textpages

${CHAPTERS}
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'thesis-edinburgh', category: 'Theses', label: 'University of Edinburgh thesis (edmaths)',
		description: "Formatted to the University of Edinburgh's thesis requirements.",
		packages: ['edmaths'], bibstyle: 'plain', title: 'Thesis Title',
		tex: `\\documentclass[12pt,twoside]{report}
\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\date{{{YEAR}}}
\\usepackage[phd,hyperref,colour,fancyhdr]{edmaths}
\\usepackage{amsmath}

\\begin{document}
\\flushbottom
\\pagenumbering{roman}
\\maketitle

\\begin{declaration}
{I declare that this thesis has been composed solely by myself and that it has
not been submitted, in whole or in part, in any previous application for a
degree. Except where stated otherwise by reference or acknowledgement, the work
presented is entirely my own.}
\\end{declaration}

\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\begin{laysummary}
A lay summary for a general audience.
\\end{laysummary}

\\begin{acknowledgements}
Thank the people who helped.
\\end{acknowledgements}

\\tableofcontents
\\newpage
\\pagenumbering{arabic}

${CHAPTERS}
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'thesis-auckland', category: 'Theses', label: 'University of Auckland thesis (aucklandthesis)',
		description: "Formatted to the University of Auckland's requirements for masters and doctoral theses.",
		packages: ['aucklandthesis'], bibstyle: 'plain', title: 'Thesis Title',
		tex: `\\documentclass[11pt]{aucklandthesis}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\subtitle{}
\\author{{{AUTHOR}}}
\\degreesought{Doctor of Philosophy}
\\degreediscipline{Physics}
\\degreecompletionyear{{{YEAR}}}
\\maketitle

\\chapter*{Abstract}
${ABSTRACT}

\\settocdepth{section}
\\cleardoublepage\\tableofcontents
\\cleardoublepage
\\setcounter{page}{1}

${CHAPTERS}
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'thesis-uiuc', category: 'Theses', label: 'University of Illinois thesis (uiucthesis)',
		description: 'Formatted to the UIUC Graduate College requirements.',
		packages: ['uiucthesis'], bibstyle: 'plain', title: 'Dissertation Title',
		tex: `\\documentclass{uiucthesis}
\\usepackage{amsmath}

\\begin{document}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\department{Physics}
\\phdthesis
\\advisor{Advisor Name}
\\degreeyear{{{YEAR}}}
\\maketitle

\\frontmatter
\\begin{abstract}
${ABSTRACT}
\\end{abstract}

\\chapter*{Acknowledgments}
Thank the people who helped.

\\tableofcontents

\\mainmatter
${CHAPTERS}
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	// --- Writing around submission -------------------------------------------
	{
		id: 'project-report', category: 'Reports and submissions', label: 'Project or lab report',
		description: 'A short structured report: aims, method, results, discussion.',
		packages: [], bibstyle: 'plain', title: 'Project Report',
		tex: `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs}
\\usepackage[hidelinks]{hyperref}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Aims}
What the project set out to do~\\cite{einstein1905}.

\\section{Method}
How it was done.

\\section{Results}
\\begin{table}[h]
  \\centering
  \\begin{tabular}{lr}
    \\toprule
    Quantity & Value \\\\
    \\midrule
    First & 1.0 \\\\
    Second & 2.0 \\\\
    \\bottomrule
  \\end{tabular}
  \\caption{Results.}
\\end{table}

\\section{Discussion}
What the results mean.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
	},
	{
		id: 'cover-letter', category: 'Reports and submissions', label: 'Cover letter to a journal editor',
		description: 'The letter that goes with a manuscript submission.',
		packages: [], bibstyle: '', title: 'Submission of our manuscript', noBib: true,
		tex: `\\documentclass[11pt]{letter}
\\usepackage[margin=1in]{geometry}

\\signature{{{AUTHOR}}}
\\address{Department\\\\ University\\\\ City, Country}

\\begin{document}

\\begin{letter}{The Editor\\\\ Journal Name}

\\opening{Dear Editor,}

We are pleased to submit our manuscript, \\emph{{{PROJECT_TITLE}}}, for
consideration for publication in \\emph{Journal Name}.

Explain in one paragraph what the paper shows and why it matters to the
journal's readers.

The manuscript is original, has not been published elsewhere, and is not under
consideration by another journal. All authors have approved the submission.

\\closing{Yours sincerely,}

\\end{letter}

\\end{document}
`,
	},
	{
		id: 'referee-response', category: 'Reports and submissions', label: 'Response to referees',
		description: "A point-by-point reply to the referees' reports for a revised submission.",
		packages: [], bibstyle: '', title: 'Response to the referees', noBib: true,
		tex: `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{xcolor}

\\newenvironment{comment}{\\par\\medskip\\noindent\\textbf{Referee:}\\itshape}{\\par}
\\newenvironment{reply}{\\par\\smallskip\\noindent\\textbf{Reply:}\\color{blue!50!black}}{\\par}

\\title{{{PROJECT_TITLE}}}
\\author{{{AUTHOR}}}
\\date{\\today}

\\begin{document}
\\maketitle

We thank the referees for their careful reading. Changes in the manuscript are
marked in blue. Our replies follow.

\\section*{Referee 1}

\\begin{comment}
The referee's first comment.
\\end{comment}
\\begin{reply}
Our reply, and what we changed in the manuscript.
\\end{reply}

\\section*{Referee 2}

\\begin{comment}
The referee's first comment.
\\end{comment}
\\begin{reply}
Our reply, and what we changed in the manuscript.
\\end{reply}

\\end{document}
`,
	},
];

fs.rmSync(OUT, { recursive: true, force: true });
for (const t of templates) {
	const dir = path.join(OUT, t.id);
	fs.mkdirSync(dir, { recursive: true });
	const manifest = {
		label: t.label,
		category: t.category,
		description: t.description,
		defaultName: t.id,
		defaultTitle: t.title,
		texPackages: t.packages,
		bibstyle: t.bibstyle,
		variables: {},
	};
	fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify(manifest, null, '\t') + '\n');
	fs.writeFileSync(path.join(dir, 'main.tex'), t.tex);
	if (!t.noBib) {
		fs.writeFileSync(path.join(dir, 'references.bib'), BIB);
	}
	fs.writeFileSync(path.join(dir, 'dot-gitignore'), '*.aux\n*.bbl\n*.blg\n*.log\n*.out\n*.toc\n*.lof\n*.lot\n*.nav\n*.snm\n*.synctex.gz\n*.fls\n*.fdb_latexmk\n*Notes.bib\nmain.pdf\n');
}
console.log(`wrote ${templates.length} templates: ${templates.map((t) => t.id).join(' ')}`);
const pkgs = [...new Set(templates.flatMap((t) => t.packages))];
console.log(`TeX Live packages: ${pkgs.join(' ')}`);
