/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript

 */


define(['N/search', 'N/record', 'N/file', 'N/encode'],
    function (search, record, file, encode) {
        /**
           * Marks the beginning of the Map/Reduce process and generates input data.
           *
           * @typedef {Object} ObjectRef
           * @property {number} id - Internal ID of the record instance
           * @property {string} type - Record type id
           *
           * @return {Array|Object|Search|RecordRef} inputSummary
           * @since 2015.1
           */


        function getInputData() {
            try {

                return search.load({
                    id: 'customsearch_574_image_base64'
                });

            } catch (e) {
                log.error("An error occurred in get input data", e.toString());
            }
        }
        /**
           * Executes when the reduce entry point is triggered and applies to each group.
           *
           * @param {ReduceSummary} context - Data collection containing the groups to process through the reduce stage
           * @since 2015.1
           */

        function reduce(context) {
            try {
                var fileTypeMapping = {
                    csv: 'CSV',
                    xls: 'EXCEL',
                    xlsx: 'EXCEL',
                    gif: 'GIFIMAGE',
                    jpg: 'JPGIMAGE',
                    jpeg: 'JPGIMAGE',
                    docx: 'WORD',
                    pdf: 'PDF',
                    png: 'PNGIMAGE',
                };

                var logJson = {};
                var recordId = context.key;
                log.debug("supportcase:" + recordId, context.values[0]);
                logJson.supportcase = recordId;

                var supportCaseFields = search.lookupFields({
                    type: 'supportcase',
                    id: recordId,
                    columns: ['casenumber', 'company', 'custevent_677_json_form', 'custevent_677_json_form_2']
                });

                var casenumber = supportCaseFields.casenumber;
                var company = supportCaseFields.company[0].value;
                var fileContents1 = supportCaseFields.custevent_677_json_form;
                var fileContents2 = supportCaseFields.custevent_677_json_form_2;

                var fileContentsParsed = JSON.parse(fileContents2.length ? fileContents1 + fileContents2 : fileContents1);

                //log.debug('fileContentsParsed ' + typeof (fileContentsParsed) + fileContentsParsed.length, fileContentsParsed);

                if (fileContentsParsed) {
                    for (var i = 0; i < fileContentsParsed.length; i++) {
                        var jsonFileContent = fileContentsParsed[i];
                        log.debug('jsonFileContent', jsonFileContent);
                        var fileName = casenumber + '_' + jsonFileContent["filename"];
                        var fileExtension = jsonFileContent["fileextension"];
                        var base64Content = jsonFileContent["base64encode"];

                        if (fileName && fileExtension && base64Content) {
                            var fileObj = file.create({
                                name: fileName,
                                fileType: fileTypeMapping[fileExtension],
                                contents: base64Content,
                                folder: 2477943
                            });
                            var fileId = fileObj.save();
                            log.debug('saving file:' + fileId, logJson);

                            var Cases_Files_Obj = record.create({
                                type: 'customrecord_cases_files',
                                isDynamic: true
                            });
                            var CasesFilesRecordFields = {
                                custrecord_cases_files_caseref: recordId,
                                custrecord_cases_files_custref: company,
                                custrecord_cases_files_fileref: fileId,
                                custrecord_cases_files_filename: fileName,
                                custrecord_cases_files_fileext: fileTypeMapping[fileExtension]
                            }
                            for (var fieldId in CasesFilesRecordFields) {
                                var value = CasesFilesRecordFields[fieldId];
                                log.debug('fieldId: ' + fieldId, value);
                                Cases_Files_Obj.setValue({
                                    fieldId: fieldId,
                                    value: value
                                });
                            }

                            try {
                                var id = Cases_Files_Obj.save();
                                log.debug('Record created successfully', 'New record ID:  ' + id);
                            } catch (e) {
                                log.error(e.name, e.message);
                            }
                        }
                    }
                }
            }
            catch (error) {
                log.error({
                    title: 'reduce',
                    details: error.toString()
                });
                //throw error;
            }
        }

        function summarize(context) {

            var governance = {
                usage: context.usage,
                concurrency: context.concurrency,
                yields: context.yields
            }

            log.audit({
                title: 'Script governance',
                details: JSON.stringify(governance)
            });

        }

        return {
            getInputData: getInputData,
            reduce: reduce,
            summarize: summarize
        };

    });